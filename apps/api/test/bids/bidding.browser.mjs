// Run with node --test against an isolated local API and Next.js stack.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

const origin = new URL(process.env.TEST_WEB_ORIGIN ?? "http://localhost:4310");
const adminEmail = process.env.DEMO_ADMIN_EMAIL;
const adminPassword = process.env.DEMO_ADMIN_PASSWORD;

function localDateTime(hours) {
  const date = new Date(Date.now() + hours * 3_600_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

test("negotiates live, assigns the winning carrier, and filters My bids", { timeout: 120_000 }, async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(origin.hostname));
  assert.ok(adminEmail && adminPassword, "Seed an admin in the isolated test database.");
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH });
  const errors = [];

  async function session() {
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && /same key|hydration|unhandled/i.test(message.text())) errors.push(message.text());
    });
    return page;
  }

  const tag = randomBytes(4).toString("hex");
  async function register(page, name, role) {
    await page.goto(new URL("/register", origin).href);
    await page.getByLabel("Display name").fill(name);
    await page.getByLabel("Email").fill(`${name.replaceAll(" ", "-").toLowerCase()}@example.test`);
    await page.getByLabel("Password").fill(`Bidding browser ${tag}!`);
    await page.getByLabel("Account type").selectOption(role);
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByText(`Signed in as ${name}.`).waitFor();
  }

  async function approveCarrier(page, admin, name, mc) {
    await register(page, name, "CARRIER");
    await page.getByLabel("Motor carrier license").fill(mc);
    await page.getByLabel("Safety rating").selectOption("SATISFACTORY");
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.getByLabel("Insurance certificate").setInputFiles({
      name: "insurance.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nBidding browser certificate\n%%EOF\n"),
    });
    await page.getByRole("button", { name: "Upload certificate" }).click();
    await page.getByText(/Insurance uploaded/).waitFor();
    await page.getByRole("button", { name: "Submit for review" }).click();
    await page.getByRole("status").filter({ hasText: "Pending" }).waitFor();
    await admin.goto(new URL("/admin/carriers", origin).href);
    await admin.getByRole("link", { name }).click();
    await admin.getByRole("heading", { name: "Review checklist" }).waitFor();
    await admin.getByText(/certificate is valid/).waitFor();
    await admin.getByText(/MC number format/).waitFor();
    await admin.getByText(/not UNSATISFACTORY/).waitFor();
    await admin.getByRole("button", { name: "Approve carrier" }).click();
    await page.getByRole("status").filter({ hasText: "Approved" }).waitFor();
  }

  async function makeOffer(scope, button, dollars) {
    await scope.getByLabel("Offer (USD)").fill(dollars);
    await scope.getByRole("button", { name: button }).click();
  }

  try {
    const [admin, shipper, winner, competitor] = await Promise.all([session(), session(), session(), session()]);
    const winnerName = `Winner ${tag}`;
    const competitorName = `Competitor ${tag}`;
    const description = `Live bid load ${tag}`;
    await admin.goto(new URL("/login", origin).href);
    await admin.getByLabel("Email").fill(adminEmail);
    await admin.getByLabel("Password").fill(adminPassword);
    await admin.getByRole("button", { name: "Sign in" }).click();
    await admin.getByRole("heading", { name: "Admin", exact: true }).waitFor();

    const mcNumber = parseInt(tag, 16);
    await approveCarrier(winner, admin, winnerName, `MC-${mcNumber}`);
    await approveCarrier(competitor, admin, competitorName, `MC-${mcNumber + 1}`);
    await register(shipper, `Shipper ${tag}`, "SHIPPER");
    await shipper.getByRole("link", { name: "Your loads" }).click();
    await shipper.getByLabel("Description").fill(description);
    await shipper.getByLabel("Pickup city").fill("New York, NY");
    await shipper.getByLabel("Delivery city").fill("Boston, MA");
    await shipper.getByLabel("Ready at (local time)").fill(localDateTime(24));
    await shipper.getByLabel("Deliver by (local time)").fill(localDateTime(48));
    await shipper.getByRole("button", { name: "Create and publish" }).click();
    await shipper.getByText(`${description} (OPEN)`, { exact: true }).waitFor();
    await shipper.getByText("New York, NY (40.7128, -74.006)", { exact: true }).waitFor();
    await shipper.getByText("Boston, MA (42.3601, -71.0589)", { exact: true }).waitFor();

    for (const carrier of [winner, competitor]) {
      await carrier.getByRole("link", { name: "Browse loads" }).click();
      await carrier.getByRole("link", { name: description }).click();
      await carrier.getByText(`${description} (OPEN)`, { exact: true }).waitFor();
    }
    await makeOffer(winner, "Place bid", "1200.00");
    const winningBid = shipper.getByRole("listitem").filter({ has: shipper.getByRole("heading", { name: winnerName }) });
    await winningBid.getByText(/Current offer \$1,200.00/).waitFor();
    await makeOffer(competitor, "Place bid", "1250.00");
    await shipper.getByRole("heading", { name: competitorName }).waitFor();

    await winner.getByRole("link", { name: "Carrier home" }).click();
    await winner.getByRole("link", { name: "My bids" }).click();
    await winner.getByLabel("Status").selectOption("ACTIVE");
    await winner.getByRole("link", { name: description }).click();

    await makeOffer(winningBid, "Send counter-offer", "1100.00");
    await winner.getByText("Shipper offered $1,100.00", { exact: true }).waitFor();
    await makeOffer(winner, "Send counter-offer", "1150.50");
    await winningBid.getByText(/Current offer \$1,150.50 · Revision 3/).waitFor();
    await winningBid.getByRole("button", { name: "Accept bid" }).click();

    for (const page of [shipper, winner, competitor]) {
      await page.getByText(`${description} (ASSIGNED)`, { exact: true }).waitFor();
    }
    await competitor.getByText(/CLOSED · Current offer \$1,250.00/).waitFor();
    const shipmentIds = [];
    for (const page of [shipper, winner]) {
      await page.getByRole("heading", { name: "Assignment" }).waitFor();
      await page.getByText(winnerName, { exact: true }).last().waitFor();
      await page.getByText("$1,150.50", { exact: true }).waitFor();
      shipmentIds.push(await page.getByText("Shipment ID", { exact: true }).locator("xpath=following-sibling::dd[1]").textContent());
    }
    assert.match(shipmentIds[0], /^[0-9a-f-]{36}$/);
    assert.equal(shipmentIds[1], shipmentIds[0]);
    assert.equal(await competitor.getByRole("heading", { name: "Assignment" }).count(), 0);

    for (const [carrier, status] of [[winner, "ACCEPTED"], [competitor, "CLOSED"]]) {
      await carrier.getByRole("link", { name: "Carrier home" }).click();
      await carrier.getByRole("link", { name: "My bids" }).click();
      await carrier.getByLabel("Status").selectOption(status);
      await carrier.getByRole("link", { name: description }).click();
      if (status === "ACCEPTED") {
        await carrier.getByText(shipmentIds[0], { exact: true }).waitFor();
        await carrier.reload();
        await carrier.getByText(shipmentIds[0], { exact: true }).waitFor();
        await carrier.getByRole("heading", { name: "Offer history" }).waitFor();
        assert.equal(await carrier.locator("ol li").count(), 3);
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
