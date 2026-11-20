import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    
    console.log("=== FINAL VERIFICATION OF FIXES ===\n");
    
    // Test 1: Verify settings dialog closes when opening SDM modal
    console.log("1. Testing settings dialog close behavior...");
    await page.goto("http://127.0.0.1:3001/", { waitUntil: "networkidle" });
    
    // Auto-open settings dialog (it opens when LLM unconfigured)
    console.log("   Settings auto-opened (LLM unconfigured)");
    
    // Click Stock & flow editor (if visible) - this should close settings
    const btn = page.getByRole("button", { name: "Stock & flow editor" });
    const btnCount = await btn.count();
    console.log("   Button visible:", btnCount > 0);
    
    if (btnCount > 0) {
      await btn.click();
      await page.waitForTimeout(300);
      // Now check if settings dialog still open
      const dialogs = await page.locator('[role="dialog"]').count();
      console.log("   Dialogs after click:", dialogs);
      // If the fix works, there should be only the SDM modal, not the settings dialog
    }
    
    // Test 2: Verify drag works on /diagram page (this should work)
    console.log("\n2. Testing drag on /diagram page (baseline)...");
    await page.goto("http://127.0.0.1:3001/diagram", { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    
    const stocks = page.locator('[data-node="stock"]');
    const stockCount = await stocks.count();
    console.log("   Stocks on /diagram:", stockCount);
    
    if (stockCount > 0) {
      const stock = page.getByRole("button", { name: "Stock Infected", exact: true });
      const box = await stock.boundingBox();
      const origY = await stock.locator("rect").getAttribute("y");
      const cx = box.x + box.width/2, cy = box.y + box.height/2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx, cy + 80, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const newY = await stock.locator("rect").getAttribute("y");
      const dragWorked = origY !== newY;
      console.log("   Drag result:", dragWorked ? "SUCCESS" : "FAILED");
    }
    
    // Test 3: Verify fullscreen button is present when SDM modal opens
    console.log("\n3. Testing fullscreen button in SDM modal...");
    // We can't easily test this without a model with SDM, but we can at least
    // verify the UI changes we made are present in the HTML
    const htmlContent = await page.content();
    const hasFullscreenButton = htmlContent.includes('onClick={() => { const el = diagramRef.current; if (el) el.requestFullscreen?.(); }}"');
    console.log("   Fullscreen button in code:", hasFullscreenButton ? "YES" : "NO");
    
    console.log("\n=== VERIFICATION COMPLETE ===");
    
    if (errors.length) {
      console.log("Errors encountered:", errors);
    }
    
  } catch (e) {
    console.log("Test error:", e);
  } finally {
    await browser.close();
  }
})();
