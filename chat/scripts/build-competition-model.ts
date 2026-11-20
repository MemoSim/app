import { writeFileSync, mkdirSync } from 'node:fs';
import { serialize } from '../src/client/model/serialize';
import { emptySpec, widgetSchema, experimentSchema } from '../src/client/model/spec';
const out = '/Users/lilo-jali/Documents/MemoSim Models/001 Species Competition';
mkdirSync(out,{recursive:true});
const s=emptySpec();
s.world={minPxcor:-25,maxPxcor:25,minPycor:-25,maxPycor:25,patchSize:9,wrapX:true,wrapY:true,updateMode:'ticks'};
s.code=`breed [ species-a individual-a ]
breed [ species-b individual-b ]
patches-own [ habitat ]
globals [ births-a births-b deaths-a deaths-b ]

to setup
  clear-all
  random-seed seed
  ask patches [
    set habitat ifelse-value (pxcor < 0) [0] [1]
    set pcolor ifelse-value (habitat = 0) [53] [33]
    if random-float 1 < initial-occupancy [
      ifelse random-float 1 < 0.5
      [ sprout-species-a 1 [ set color sky set shape "circle" set size 0.7 ] ]
      [ sprout-species-b 1 [ set color orange set shape "circle" set size 0.7 ] ]
    ]
  ]
  reset-ticks
end

to go
  set births-a 0
  set births-b 0
  set deaths-a 0
  set deaths-b 0
  ; Death precedes recruitment. Newborns cannot reproduce until next tick.
  ask turtles [
    if random-float 1 < mortality [
      ifelse breed = species-a [ set deaths-a deaths-a + 1 ] [ set deaths-b deaths-b + 1 ]
      die
    ]
  ]
  ask turtles [
    let destination one-of neighbors
    if not any? turtles-on destination [
      let preferred ifelse-value (breed = species-a) [0] [1]
      let fitness ifelse-value ([habitat] of destination = preferred) [1] [1 - niche-strength]
      let fecundity ifelse-value (breed = species-a) [reproduction-a] [reproduction-b]
      if random-float 1 < fecundity * fitness [
        ifelse breed = species-a [ set births-a births-a + 1 ] [ set births-b births-b + 1 ]
        hatch 1 [ move-to destination ]
      ]
    ]
  ]
  tick
end

to-report coexistence?
  report any? species-a and any? species-b
end

to-report occupancy
  report count turtles / count patches
end

to-report invariants-ok?
  report not any? patches with [ count turtles-here > 1 ] and count turtles <= count patches
end
`;
s.info=`## WHAT IS IT?
An exploratory spatial competition model: two species compete for vacant sites in two habitat regions. It is not calibrated to a particular ecosystem. One tick is an abstract generation interval.

## HOW IT WORKS
The wrapped 51 by 51 grid has habitat 0 on the left and habitat 1 on the right. Each patch holds at most one organism. Initial occupied sites receive either species with equal probability. All organisms experience independent mortality first. Survivors, in random order, attempt one birth into a uniformly sampled neighboring site. Occupied targets reject recruitment. Species A favors habitat 0; B favors habitat 1. Birth probability equals the species reproduction parameter, multiplied by 1 in preferred habitat or 1 minus niche-strength elsewhere. Newborns reproduce next tick. There is no movement or mutation. Asynchronous recruitment makes competition for empty sites explicit.

## HOW TO USE IT
Press Setup, then Go. Blue circles are species A; orange circles are species B. Background colors show habitats. Adjust seed for independent realizations. Setup is required after changing seed or initial-occupancy. Other parameters take effect immediately. Step advances one tick. Reset with the same parameters and seed reproduces the trajectory.

## THINGS TO TRY
Set niche-strength to 0 and reproduction-a above reproduction-b to explore an advantage in a shared niche. Increase niche-strength toward 1 to create habitat specialization. Compare multiple seeds and long horizons: temporary joint persistence is not proof of stable coexistence. At niche-strength 1 each species can recruit only in its preferred half, but initially misplaced organisms persist until death.

## MEASURES AND EXPERIMENTS
Population and occupancy plots track dynamics. Invariants check site exclusion and population bounds. BehaviorSpace niche-sweep compares niche-strength 0, 0.5, and 1 over seeds 1 through 10, with 500 ticks per run. These are exploratory comparisons, not empirical predictions.

## LIMITATIONS
Two equal-quality fixed habitats, common mortality, no environmental change, no dispersal beyond immediate neighbors, and arbitrary parameter defaults. Extinction is irreversible. Periodic borders connect both habitat edges. Validate and calibrate against ecological data before using results for decisions.

## PROVENANCE
MemoSim library model 001: Species Competition and Coexistence. Original educational implementation; not a reproduction of a published empirical model. See accompanying experiment results for executed checks.
`;
const ws:any[]=[
{kind:'button',label:'Setup',code:'setup'}, {kind:'button',label:'Go',code:'go',forever:true}, {kind:'button',label:'Step',code:'go'},
...Object.entries({'seed':[1,10000,1,42],'initial-occupancy':[0,1,0.05,0.6],'reproduction-a':[0,1,0.05,0.65],'reproduction-b':[0,1,0.05,0.5],'mortality':[0,1,0.01,0.12],'niche-strength':[0,1,0.05,0.8]}).map(([variable,v])=>({kind:'slider',variable,min:v[0],max:v[1],step:v[2],default:v[3]})),
{kind:'monitor',label:'Species A',reporter:'count species-a',precision:0},{kind:'monitor',label:'Species B',reporter:'count species-b',precision:0},{kind:'monitor',label:'Both species present',reporter:'coexistence?',precision:0},{kind:'monitor',label:'Site exclusion holds',reporter:'invariants-ok?',precision:0},
{kind:'plot',title:'Populations',yLabel:'organisms',ymax:2601,pens:[{name:'A',color:'sky',update:'plot count species-a'},{name:'B',color:'orange',update:'plot count species-b'}]},
{kind:'plot',title:'Occupied sites',yLabel:'fraction',ymax:1,pens:[{name:'occupancy',color:'green',update:'plot occupancy'}]}
];
s.widgets=ws.map((w,i)=>({...widgetSchema.parse(w),id:'w'+i})) as any;
s.experiments=[experimentSchema.parse({name:'niche-sweep',setup:'setup',go:'go',timeLimit:500,repetitions:1,metrics:['count species-a','count species-b','coexistence?','occupancy','invariants-ok?'],parameters:[{variable:'niche-strength',values:[0,0.5,1]},{variable:'seed',first:1,step:1,last:10}]}),experimentSchema.parse({name:'smoke',setup:'setup',go:'go',timeLimit:30,metrics:['count species-a','count species-b','invariants-ok?']})];
writeFileSync(out+'/Species Competition.nlogox',serialize(s));
writeFileSync(out+'/model-spec.json',JSON.stringify(s,null,2));
writeFileSync(out+'/README.md',s.info);
console.log(out);
