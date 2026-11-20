import SystemDynamicsEditor from "@/components/SystemDynamicsEditor";
import { sdmSchema } from "@/client/model/spec";

export default function DiagramExample() {
  const model = sdmSchema.parse({
    dt: 0.1,
    stocks: [{ name: "Susceptible", initial: "990" }, { name: "Infected", initial: "10" }, { name: "Recovered", initial: "0" }],
    flows: [
      { name: "new-arrivals", from: "outside", to: "Susceptible", rate: "arrival-rate" },
      { name: "infections", from: "Susceptible", to: "Infected", rate: "contact-rate * Susceptible * Infected / 1000" },
      { name: "recoveries", from: "Infected", to: "Recovered", rate: "Infected / infectious-days" },
      { name: "departures", from: "Recovered", to: "outside", rate: "Recovered * 0.001" },
    ],
    converters: [{ name: "contact-rate", value: "0.3" }, { name: "infectious-days", value: "10" }, { name: "arrival-rate", value: "1" }],
  });
  return <main className="flex h-screen flex-col bg-slate-100 p-3 sm:p-6"><div className="mb-4"><p className="text-xs font-semibold uppercase tracking-widest text-slate-500">MemoSim · stock & flow modeler</p><h1 className="mt-1 text-xl font-semibold text-slate-800">Epidemic dynamics</h1><p className="mt-1 text-xs text-slate-500">Edit the model below. An illustrative diagram, not a calibrated health model. No simulation is running on this standalone page.</p></div><div className="min-h-0 flex-1"><SystemDynamicsEditor model={model} title="Susceptible → Infected → Recovered" /></div></main>;
}
