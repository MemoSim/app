import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { emptySpec, sdmSchema, widgetSchema } from "../src/client/model/spec";
import { serialize } from "../src/client/model/serialize";

const spec = emptySpec();
spec.sdm = sdmSchema.parse({
  dt: 0.1,
  stocks: [
    { name: "recovered", initial: "0" },
    { name: "susceptible", initial: "990" },
    { name: "infected", initial: "10" },
  ],
  flows: [
    { name: "infections", from: "susceptible", to: "infected", rate: "contact-rate * susceptible * infected / population" },
    { name: "recoveries", from: "infected", to: "recovered", rate: "infected / infectious-days" },
  ],
  converters: [
    { name: "contact-rate", value: "0.3" },
    { name: "infectious-days", value: "10" },
    { name: "population", value: "susceptible + infected + recovered" },
  ],
});
spec.code = `to setup
  clear-all
  system-dynamics-setup
  reset-ticks
  system-dynamics-do-plot
end

to go
  system-dynamics-go
  system-dynamics-do-plot
  tick
end`;
spec.info = `# Epidemic dynamics — automatic layout demo

Open Tools > System Dynamics Modeler (Command-Shift-D) to see the diagram.
The stocks are declared in a deliberately different order from their flow:
the presentation arranges susceptible → infected → recovered automatically.

Press Setup and Go on the Interface tab to see the outbreak curves.
This illustrative SIR model is uncalibrated and is not health advice.
The diagram coordinates change; equations, timestep and native solver do not.`;
spec.widgets = [
  { kind: "button", label: "Setup", code: "setup" },
  { kind: "button", label: "Go", code: "go", forever: true },
  { kind: "plot", title: "Outbreak", xLabel: "time", yLabel: "people", ymax: 1000, pens: [
    { name: "susceptible", color: "blue", update: "" },
    { name: "infected", color: "red", update: "" },
    { name: "recovered", color: "green", update: "" },
  ] },
].map((w, i) => ({ ...widgetSchema.parse(w), id: `w${i + 1}` }));
const file = join(homedir(), "Documents", "MemoSim Models", "System Dynamics Layout Demo.nlogox");
writeFileSync(file, serialize(spec));
console.log(file);
