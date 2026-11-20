const DBG = "http://127.0.0.1:9234";
const js = async (c: string) => (await fetch(`${DBG}/js`, { method: "POST", body: c })).text();
// kick off async fetch, then poll for result
await js(`window.__st=null; fetch('/api/projects').then(r=>r.json()).then(j=>fetch('/api/projects/'+j.projects[0].id)).then(r=>r.json()).then(f=>{window.__st=JSON.stringify(f.state.history)}); 'started'`);
let raw = "";
for (let i = 0; i < 20 && (!raw || raw === "null"); i++) { await new Promise((r) => setTimeout(r, 300)); raw = await js(`window.__st`); }
const hist = JSON.parse(raw) as Array<{ role: string; content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>;
const from = Number(process.argv[2] ?? 0), n = Number(process.argv[3] ?? 6);
let shown = 0;
hist.forEach((m, i) => {
  if (i < from || shown >= n) return;
  shown++;
  if (m.role === "assistant" && m.tool_calls) for (const c of m.tool_calls) console.log(`#${i} CALL ${c.function.name}: ${c.function.arguments.slice(0, 1500)}`);
  else console.log(`#${i} ${m.role}: ${String(m.content).slice(0, 1200)}`);
});
console.log("total messages:", hist.length);
