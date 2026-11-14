# Sats Jar: "Draw my life" voice-over script (v3, ElevenLabs)

**The film.** One life from birth to eighteen, in the "Draw my life" storytelling style: a hand
draws each moment in crayon, in fast-forward, on a white page. 54 seconds, 16:9, no voice in the
cut. Generate this script in ElevenLabs and lay it over `sats-jar-draw-my-life-v3.mp4`.

**The one idea.** A jar the people who love you fill up, that nobody can raid, and that becomes
yours when you're grown.

## How this is written for ElevenLabs

Following the ElevenLabs prompting guide (elevenlabs.io/docs/best-practices/prompting):

- **Model:** Eleven v4 (or v3; the guide says v3 takes the same tags and punctuation).
- **No `<break>` tags.** v3 and v4 don't support SSML breaks. Pauses come from ellipses (`...`),
  dashes (`—`), full stops and line structure.
- **Audio tags** in square brackets describe the voice, not actions or music, and sit at the start
  of the line they shape. Used sparingly: one per scene at most.
- **Numbers spelled out:** "eighteen", "twelve", "sixteen", never "18".
- **Emphasis by CAPS** on a single word where the line turns.
- **Settings:** Stability around the middle (lower is more expressive, higher is steadier; drop
  it a notch if the read sounds flat). Similarity at default. No Style or Speed sliders on v4.
- **Voice:** a warm, young-adult first-person narrator, looking back with a smile.

## Generate one clip per scene

Pauses from punctuation aren't exact, so generate each block below as its own clip and drop it
at its time in the edit. Each block fits inside its scene with room to spare; if a clip runs
long, regenerate it rather than speeding it up.

| Start | On the page | Paste into ElevenLabs |
|-------|-------------|-----------------------|
| 0:00 | "Draw my life (and my jar)" | `[Warm, intimate narration] This is my life... and my jar.` |
| 0:03 | **Day 1.** Grandpa holds the baby, tosses a coin into a new jar. "This one's for later." | `The day I was born, Grandpa made me a jar. One coin... [softly] "This one's for later."` |
| 0:09 | **The rules**, on a note tied to the jar. | `Then he set the rules. A little each month. All of it at eighteen. And NOBODY can change them... [gentle amusement] not even him.` |
| 0:17 | **Ages 1, 5, 7:** first steps, first day of school, a lost tooth. Aunt, Mum and Mr. Lee drop coins in. | `First steps. First day of school. First lost tooth. Every big moment — someone dropped a coin in.` |
| 0:25 | **Age 9.** Dad at a table of bills; the jar on a shelf, stamped RULES SAY NO. | `[Quiet, reflective narration] When money got tight... the rules said no. Nobody could touch it.` |
| 0:30 | **Age 12.** "Your monthly gift arrived!" A sketchbook: "Draw my life". | `[Brighter] At twelve, my monthly gift bought THIS sketchbook.` |
| 0:34 | **Age 16.** Grandpa at Sunny Days Care Home, phone up; a coin arcs to her birthday jar. | `Grandpa moved into a care home. But every birthday... a coin still arrived.` |
| 0:40 | **Age 18.** "The jar is yours now." The jar fills to the brim and heaps over the top. | `At eighteen, the jar became mine. Every coin, from everyone who loved me. [Gentle pause, then quiet realization] And Grandpa's first one... right at the bottom.` |
| 0:49 | "Some gifts grow up with you." Sats Jar. Testnet line. | `Some gifts grow up with you... Sats Jar.` |

## Straight through (one clip, about 110 words)

If you'd rather generate it in one go and cut it apart in the edit, paste this:

```text
[Warm, intimate narration] This is my life... and my jar.

The day I was born, Grandpa made me a jar. One coin... [softly] "This one's for later."

Then he set the rules. A little each month. All of it at eighteen. And NOBODY can change them... [gentle amusement] not even him.

First steps. First day of school. First lost tooth. Every big moment — someone dropped a coin in.

[Quiet, reflective narration] When money got tight... the rules said no. Nobody could touch it.

[Brighter] At twelve, my monthly gift bought THIS sketchbook.

Grandpa moved into a care home. But every birthday... a coin still arrived.

At eighteen, the jar became mine. Every coin, from everyone who loved me. [Gentle pause, then quiet realization] And Grandpa's first one... right at the bottom.

Some gifts grow up with you... Sats Jar.
```

## If you use an older model (Multilingual v2 or Flash)

Those models ignore the bracketed tags and may read them aloud. Delete every `[...]` tag, and
where you want an exact pause you can use `<break time="0.6s" />` instead of an ellipsis (up to
3 s). Keep the breaks to a handful: the guide warns that too many in one clip make the voice
speed up or glitch.

## Checks before you export

- "Sats" should come out as one word rhyming with "hats". If it doesn't, try `Satz` in that line
  only, or add a pronunciation-dictionary alias.
- Listen for any tag read aloud (for example "brighter"). If that happens, delete that tag; the
  punctuation alone carries the line.
- The end card still shows the testnet line on screen; the voice doesn't need to say it.

## What it claims, checked against the product

- **The rules, set once:** the giver sets the cap, the unlock date, the child's address and the
  guardians when making the jar, and nobody can change them afterwards (glossary: Rule; ADR 0005).
- **A little each month:** the allowance, up to the cap once per 30-day period, paid only to the
  child's address, which a parent registers.
- **Dad couldn't touch it:** before handover the jar can only pay the child's address, capped. The
  refusal is kept on the record.
- **All of it at eighteen:** handover, on or after the unlock date, once the guardians confirm her
  own account and a public delay passes. The film shows it as one moment.
- **A coin from the care home:** anyone with Bitcoin can top up from their own wallet or exchange
  app, wherever they are. A relative with no Bitcoin cannot yet.
- The end card carries the testnet line. "Sats Jar" is the working name.

## Production

- Source: `video/draw_my_life.py`. Needs Chrome, ffmpeg and a Python with Pillow and NumPy.
  `still N` checks one scene's layout; `timing` prints the timeline.
- Output: `sats-jar-draw-my-life-v3.mp4` (crayon sound only) and a `-small` viewing copy.
- No music: nothing licensed yet. The crayon scratch is generated, so it is free to use.
