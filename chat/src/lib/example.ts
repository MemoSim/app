/** Verified-compiling reference model (slider variables defined by widgets). Shown to the LLM in the system prompt. */
export const EXAMPLE_CODE = `breed [ sheep a-sheep ]
breed [ wolves wolf ]
turtles-own [ energy ]
patches-own [ grass ]

to setup
  clear-all
  ask patches [ set grass random 10  recolor ]
  create-sheep initial-sheep [ setxy random-xcor random-ycor  set color white  set energy random 20 ]
  create-wolves initial-wolves [ setxy random-xcor random-ycor  set color black  set energy random 40 ]
  reset-ticks
end

to go
  if not any? turtles [ stop ]
  ask sheep [
    move
    set energy energy - 1
    if grass > 0 [ set grass grass - 1  set energy energy + sheep-gain ]
    if random-float 100 < sheep-reproduce [ set energy energy / 2  hatch 1 [ rt random 360  fd 1 ] ]
    if energy < 0 [ die ]
  ]
  ask wolves [
    move
    set energy energy - 1.5
    let prey one-of sheep-here
    if prey != nobody [ ask prey [ die ]  set energy energy + wolf-gain ]
    if random-float 100 < wolf-reproduce [ set energy energy / 2  hatch 1 [ rt random 360  fd 1 ] ]
    if energy < 0 [ die ]
  ]
  ask patches [
    if grass < 10 and random 100 < 5 [ set grass grass + 1 ]
    recolor
  ]
  tick
end

to move
  rt random 50  lt random 50  fd 1
end

to recolor
  set pcolor scale-color green grass 0 10
end`;
