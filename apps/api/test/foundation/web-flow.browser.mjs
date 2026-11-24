// Run with node --test against the isolated database and a Next.js dev server.
// Install Playwright separately or set PLAYWRIGHT_MODULE to its local entry point.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const origin = new URL(process.env.TEST_WEB_ORIGIN ?? "http://localhost:4310");
const adminEmail = process.env.DEMO_ADMIN_EMAIL;
const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
const certificate = Buffer.from("%PDF-1.7\nFreightLink browser test certificate\n%%EOF\n");

test("StrictMode carrier verification, certificate download and load lifecycle", { timeout: 120_000 }, async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(origin.hostname), "Use a local browser test stack.");
  assert.ok(adminEmail && adminPassword, "Seed a test admin and set its credentials for the browser test.");
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH });
  const errors = [];

  async function session() {
    const page = await browser.newPage();
    page.setDefaultTimeout(12_000);
    await page.addInitScript(() => {
      window.freightlinkUnhandledRejections = [];
      window.addEventListener("unhandledrejection", (event) => {
        window.freightlinkUnhandledRejections.push(String(event.reason));
      });
    });
    page.on("pageerror", (error) => errors.push(`${error.name}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" && /AbortError|hydration|unhandled/i.test(message.text())) errors.push(message.text());
    });
    return page;
  }

  const tag = randomUUID().slice(0, 8);
  const carrierName = `Test Carrier ${tag}`;
  const loadName = `Pallets ${tag}`;
  const revisedName = `Revised ${loadName}`;

  async function register(page, name, role) {
    await page.goto(new URL("/register", origin).href);
    await page.getByLabel("Display name").fill(name);
    await page.getByLabel("Email").fill(`${role.toLowerCase()}-${tag}@example.test`);
    await page.getByLabel("Password").fill(`Browser smoke ${tag}!`);
    await page.getByLabel("Account type").selectOption(role);
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByText(`Signed in as ${name}.`).waitFor();
  }

  try {
    const carrier = await session();
    const admin = await session();
    const shipper = await session();

    await register(carrier, carrierName, "CARRIER");
    await carrier.addInitScript(() => {
      const probe = { calls: 0, rejected: 0, rejectNext: false, slowPath: null, started: 0, aborted: 0 };
      window.freightlinkSessionProbe = probe;
      const fetch = window.fetch.bind(window);
      window.fetch = (resource, options) => {
        const path = typeof resource === "string" ? new URL(resource, location.href).pathname : null;
        if (probe.slowPath && path === probe.slowPath) {
          probe.started++;
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":'));
              options?.signal?.addEventListener("abort", () => {
                probe.aborted++;
                controller.error(options.signal.reason);
              }, { once: true });
            },
          });
          return Promise.resolve(new Response(stream));
        }
        if (path === "/api/v1/users/me") {
          probe.calls++;
          if (probe.calls === 1 || probe.calls === 3 || probe.rejectNext) {
            probe.rejectNext = false;
            probe.rejected++;
            return Promise.reject(new DOMException("Browser test interruption", "AbortError"));
          }
        }
        return fetch(resource, options);
      };
    });
    await carrier.goto(new URL("/carrier", origin).href);
    // Without StrictMode's second effect setup, the deliberately aborted initial read leaves this page loading.
    await carrier.getByRole("heading", { name: "Carrier verification" }).waitFor();
    // The two initial setups are followed by the first socket connect callback.
    await carrier.waitForFunction(() => window.freightlinkSessionProbe.rejected === 2);
    await carrier.evaluate(() => {
      window.freightlinkSessionProbe.rejectNext = true;
      window.dispatchEvent(new Event("focus"));
    });
    await carrier.waitForFunction(() => window.freightlinkSessionProbe.rejected === 3);

    // Hold a session response open, then let a second focus event replace it.
    await carrier.evaluate(() => {
      window.freightlinkSessionProbe.slowPath = "/api/v1/users/me";
      window.dispatchEvent(new Event("focus"));
    });
    await carrier.waitForFunction(() => window.freightlinkSessionProbe.started === 1);
    const sessionResponse = carrier.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/users/me" && response.ok());
    await carrier.evaluate(() => {
      window.freightlinkSessionProbe.slowPath = null;
      window.dispatchEvent(new Event("focus"));
    });
    await sessionResponse;
    await carrier.waitForFunction(() => window.freightlinkSessionProbe.aborted === 1);
    await carrier.getByLabel("Motor carrier license").fill(`MC-${tag}`);
    await carrier.getByLabel("Safety rating").selectOption("SATISFACTORY");
    await carrier.getByRole("button", { name: "Save profile" }).click();
    await carrier.getByLabel("Insurance certificate").setInputFiles({ name: "insurance.pdf", mimeType: "application/pdf", buffer: certificate });
    await carrier.getByRole("button", { name: "Upload certificate" }).click();
    await carrier.getByText(/Insurance uploaded/).waitFor();
    await carrier.getByRole("button", { name: "Submit for review" }).click();
    await carrier.getByRole("status").filter({ hasText: "Pending review" }).waitFor();

    await admin.goto(new URL("/login", origin).href);
    await admin.getByLabel("Email").fill(adminEmail);
    await admin.getByLabel("Password").fill(adminPassword);
    await admin.getByRole("button", { name: "Sign in" }).click();
    await admin.getByRole("link", { name: "Pending carrier reviews" }).click();
    await admin.getByRole("link", { name: carrierName }).click();
    const [download] = await Promise.all([
      admin.waitForEvent("download"), admin.getByRole("button", { name: "Download certificate" }).click(),
    ]);
    assert.equal(download.suggestedFilename(), "insurance.pdf");
    assert.deepEqual(await readFile(await download.path()), certificate);
    await admin.getByRole("button", { name: "Approve carrier" }).click();
    await admin.getByRole("status").filter({ hasText: "Approved" }).waitFor();
    await carrier.getByRole("status").filter({ hasText: "Approved" }).waitFor();

    const shipperName = `Test Shipper ${tag}`;
    await register(shipper, shipperName, "SHIPPER");
    await shipper.getByRole("link", { name: "Your loads" }).click();
    await shipper.getByLabel("Description").fill(loadName);
    const dateTime = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString().slice(0, 16);
    await shipper.getByLabel("Pickup city").fill("Columbus, OH");
    await shipper.getByLabel("Delivery city").fill("Indianapolis, IN");
    await shipper.getByLabel("Ready at (local time)").fill(dateTime(48));
    await shipper.getByLabel("Deliver by (local time)").fill(dateTime(72));
    await shipper.getByRole("button", { name: "Create draft" }).click();
    await shipper.getByText(`${loadName} (DRAFT)`, { exact: true }).waitFor();
    await shipper.getByLabel("Description").fill(revisedName);
    await shipper.getByRole("button", { name: "Save changes" }).click();
    await shipper.getByText(`${revisedName} (DRAFT)`, { exact: true }).waitFor();
    await shipper.getByRole("button", { name: "Publish load" }).click();
    await shipper.getByText(`${revisedName} (OPEN)`, { exact: true }).waitFor();

    await carrier.getByRole("link", { name: "Browse loads" }).click();
    await carrier.getByRole("link", { name: revisedName }).click();
    await carrier.getByText(`${revisedName} (OPEN)`, { exact: true }).waitFor();
    await shipper.getByRole("button", { name: "Cancel load" }).click();
    await shipper.getByText(`${revisedName} (CANCELLED)`, { exact: true }).waitFor();
    await carrier.getByRole("link", { name: "Open loads" }).click();
    await carrier.getByText("No open loads on this page.").waitFor();

    // Leave the load list while its GET is still reading a response body.
    await carrier.getByRole("link", { name: "Carrier home" }).click();
    await carrier.getByRole("heading", { name: "Carrier verification" }).waitFor();
    await carrier.evaluate(() => { window.freightlinkSessionProbe.slowPath = "/api/v1/loads"; });
    await carrier.getByRole("link", { name: "Browse loads" }).click();
    await carrier.waitForFunction(() => {
      const { started, aborted } = window.freightlinkSessionProbe;
      return started > aborted;
    });
    await carrier.getByRole("link", { name: "Carrier home" }).click();
    await carrier.getByRole("heading", { name: "Carrier verification" }).waitFor();
    await carrier.waitForFunction(() => {
      const { started, aborted } = window.freightlinkSessionProbe;
      return started >= 2 && started === aborted;
    });
    await carrier.getByRole("link", { name: "Sign out" }).click();
    await carrier.getByRole("heading", { name: "Sign out" }).waitFor();
    await carrier.getByRole("button", { name: "Sign out" }).click();
    await carrier.getByRole("heading", { name: "Sign in" }).waitFor();

    for (const page of [carrier, admin, shipper]) {
      assert.deepEqual(await page.evaluate(() => window.freightlinkUnhandledRejections), []);
      assert.equal(await page.locator("[data-nextjs-dialog-overlay], [data-nextjs-toast-errors]").count(), 0);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
