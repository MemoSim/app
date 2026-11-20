/** Drives the chat panel inside the real NetLogo Desktop with the live LLM. Usage: npx tsx tests/e2e/desktop-chat.mts "<prompt>" [shot.png] */
import fs from "node:fs";
const DBG = "http://127.0.0.1:9234";
const js = async (c: string) => (await fetch(`${DBG}/js`, { method: "POST", body: c })).text();
const prompt = process.argv[2]!;
const shot = process.argv[3] ?? "/tmp/desktop-chat.png";

// fresh project so earlier chats do not interfere
await js(`(function(){ var b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='New model'); if(b) b.click(); return 'ok'})()`);
await new Promise((r) => setTimeout(r, 2500));
await js(`(function(){ var t=document.querySelector('textarea'); var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t, ${JSON.stringify(prompt)}); t.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'})()`);
await new Promise((r) => setTimeout(r, 300));
await js(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Send').click(); 'sent'`);
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const working = await js(`document.body.innerText.includes('working…')`);
  const chips = Number(await js(`document.querySelectorAll('button.font-mono').length`));
  if (working === "false" && chips > 0) break;
  if (Date.now() - t0 > 540_000) { console.log("TIMEOUT"); break; }
}
await new Promise((r) => setTimeout(r, 1500));
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log("tools:", await js(`[...document.querySelectorAll('button.font-mono')].map(x=>x.textContent.trim()).join(' | ')`));
console.log("notices:", await js(`[...document.querySelectorAll('.border-amber-300,.border-green-300')].map(x=>x.textContent.slice(0,200)).join(' || ') || '(none)'`));
console.log("--- chat tail ---\n" + (await js(`document.querySelector('.overflow-y-auto').innerText.split('\\n').slice(-10).join('\\n')`)));
fs.writeFileSync(shot, Buffer.from(await (await fetch(`${DBG}/shot`)).arrayBuffer()));
