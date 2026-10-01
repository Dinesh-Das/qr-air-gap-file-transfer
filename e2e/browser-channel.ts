const requested = process.env.QRFT_TEST_BROWSER_CHANNEL;
if (requested !== undefined && requested !== "chrome" && requested !== "msedge") {
  throw new Error("QRFT_TEST_BROWSER_CHANNEL must be chrome or msedge, or unset for bundled Chromium.");
}
export const browserChannel = requested;
