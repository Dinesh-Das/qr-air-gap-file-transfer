import { test, expect } from "@playwright/test";

test("large optical receiver checks cryptography before requesting the camera", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "subtle", { configurable: true, value: undefined });
    const state = window as unknown as { cameraCalls: number };
    state.cameraCalls = 0;
    navigator.mediaDevices.enumerateDevices = async () => { state.cameraCalls++; return []; };
    navigator.mediaDevices.getUserMedia = async () => {
      state.cameraCalls++;
      throw new Error("The unsupported receiver must not request camera access.");
    };
  });
  await page.goto("/");
  await page.getByText("Other transfer methods", { exact: true }).click();
  await page.getByRole("button", { name: "Offline QR / Air-gap mode", exact: true }).click();
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  const message = page.getByRole("alert").filter({ hasText: "This browser cannot store transfer data safely." });
  await expect(message).toBeVisible();
  await page.getByRole("button", { name: "Start QRF3 connection test", exact: true }).click();
  await expect(message).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { cameraCalls: number }).cameraCalls)).toBe(0);
  expect(errors).toEqual([]);
});

test("home opens Send or Receive directly and keeps both optical engines available", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Receive", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Offline QR / Air-gap mode", exact: true })).toBeHidden();
  await expect(page.locator("body")).not.toContainText("WebRTC");
  await page.screenshot({ path: test.info().outputPath("home-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("home-narrow.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Six-digit pairing code" })).toBeVisible();
  await expect(page.getByText("Ready to connect", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose folder", exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/WebRTC|OPFS|Web Locks|SDP/);
  await page.screenshot({ path: test.info().outputPath("receive-desktop.png"), fullPage: true });
  await expect(page.getByRole("button", { name: "Connect to sender", exact: true })).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose folder", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Choose files", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.locator("body")).not.toContainText(/WebRTC|OPFS|Web Locks|SDP/);
  await page.screenshot({ path: test.info().outputPath("send-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByText("Other transfer methods", { exact: true }).click();
  await page.getByRole("button", { name: "Offline QR / Air-gap mode", exact: true }).click();
  await expect(page.getByRole("button", { name: "Large QRF3", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Disk-streamed optical sender", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Classic QRF2", exact: true }).click();
  await expect(page.getByText("Optical sender", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
