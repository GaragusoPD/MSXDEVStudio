# Music and sound effects

You will end up with a program that plays a looping song, fires sound effects
over it from the keyboard, plays a jingle that interrupts the song and hands it
back where it was, and pauses and fades the music — all of it through the C that
MSXDEVStudio writes for you.

**MSXDEVStudio resources:** a `.sfx.json` bank and a `.music.json` bank ·
**Samples:** `projects/samples/s_ayfx.c`, `projects/samples/s_lvgm.c` ·
**LibModules:** `system`, `bios`, `vdp`, `print`, `input`, `memory`, `psg`,
`vgm/lvgm_player`, `ayfx/ayfx_player` · **Machine:** MSX1 and up

## What it does

1. Shows a list of keys in SCREEN 1.
2. Starts the bank's song, looping, the moment it boots.
3. Every frame: waits for the V-blank, plays one frame of sound, and reads the
   keys — SPACE and X fire two sound effects, J plays a jingle over the song, P
   pauses and resumes, F fades out, M starts the song again.
4. Prints what the music is doing: playing, paused, jingle, stopped.

## The sound chip

Every MSX has the same sound chip, the **PSG** (AY-3-8910): three square-wave
channels, A, B and C, plus one noise generator any of them can mix in. Each
channel has a pitch and a volume from 0 to 15, and that is all — no samples, no
instruments. Everything you hear in an MSX1 game is a program rewriting those
fourteen registers fast enough, usually once per frame (50 times a second in
Europe, 60 in Japan).

So a sound, to the machine, is a list of register values per frame, and the two
banks MSXDEVStudio makes are two ways of storing such lists:

- **Sound effects** are **ayFX** (Shiru's format, the standard for MSX games). An
  effect drives one channel for a moment — a pickup, a jump, an explosion — and
  borrows it from whatever music was using it.
- **Music** is **lVGM**, MSXgl's own register-log format: the editor renders
  each song to one set of registers per frame, and the game replays exactly
  those. What the editor plays is what the MSX plays.

The two share one register buffer, `g_PSG_Regs`, which `PSG_Apply()` writes to
the chip. The ready-made C below exists mostly to get the order right between
them.

## Making the sounds

**The effects.** In the **Resources** panel, pick *sound effects*, name it
`sfx`, press **New**. The bank opens with one blank effect. From **Preset…**
add **pickup** and then **explosion** — they are appended, already named.
Select *explosion* and set its **Priority** to 2: priority 0 is the most
important, the default is 8, and an effect only cuts off one that matters as much
or less. Now a pickup can't cut an explosion short, but an explosion cuts a
pickup off. Leave **Channel** on C. Tick **Export ready-made C**.

**The music.** In the Resources panel, pick *music*, name it `music`, press
**New**. The bank opens with a demo song, *theme*, so Space already plays
something. Press **+** under *Songs* to add a second song and rename it
`fanfare` in the list. Set its **Bars** to 1 and **Speed** to 3, pick the *lead*
instrument, and draw four notes climbing: C5, E5 and G5 as 1/8 notes, then C6
for the rest of the bar. Any short tune works: it is your jingle.

Then, still in the music editor:

- under **Sound effects**, pick `res/sfx.sfx.json` — the music now knows
  which effects play over it, and keys 1–9 audition them over the song;
- tick **Export ready-made C**;
- press **Set up project**. It adds `psg`, `vgm/lvgm_player` and
  `ayfx/ayfx_player` to LibModules and fixes three lines of `msxgl_config.h`
  (see *Sound effects and music* in [Resources](../resources.md) for which,
  and why).

Press the party-popper button beside *fanfare* while *theme* plays: that is the
jingle you are about to program, heard in the editor first.

## The full program

```c
#include "msxgl.h"
#include "content/music.h"
#include "content/sfx.h"

// The keys this program reads, one bit each.
#define K_PICKUP 0x01   // SPACE
#define K_BOOM   0x02   // X
#define K_JINGLE 0x04   // J
#define K_PAUSE  0x08   // P
#define K_FADE   0x10   // F
#define K_MUSIC  0x20   // M

u8 ReadKeys()
{
	u8 keys = 0;
	if (Keyboard_IsKeyPressed(KEY_SPACE)) keys |= K_PICKUP;
	if (Keyboard_IsKeyPressed(KEY_X))     keys |= K_BOOM;
	if (Keyboard_IsKeyPressed(KEY_J))     keys |= K_JINGLE;
	if (Keyboard_IsKeyPressed(KEY_P))     keys |= K_PAUSE;
	if (Keyboard_IsKeyPressed(KEY_F))     keys |= K_FADE;
	if (Keyboard_IsKeyPressed(KEY_M))     keys |= K_MUSIC;
	return keys;
}

//-----------------------------------------------------------------------------
// Program entry point
void main()
{
	VDP_SetMode(VDP_MODE_SCREEN1);
	VDP_ClearVRAM();
	VDP_EnableVBlank(TRUE);
	Print_SetTextFont(PRINT_DEFAULT_FONT, 1);

	Print_SetPosition(2, 2);  Print_DrawText("MUSIC AND SOUND");
	Print_SetPosition(2, 5);  Print_DrawText("SPACE  pickup");
	Print_SetPosition(2, 6);  Print_DrawText("X      explosion");
	Print_SetPosition(2, 7);  Print_DrawText("J      jingle");
	Print_SetPosition(2, 8);  Print_DrawText("P      pause / resume");
	Print_SetPosition(2, 9);  Print_DrawText("F      fade out");
	Print_SetPosition(2, 10); Print_DrawText("M      music again");

	g_Sfx_Init();                          // first: RAM is not cleared at boot
	g_Music_Play(g_Music_Theme, TRUE);     // TRUE: loop from the song's loop bar

	bool paused = FALSE;
	u8 held = 0;
	while (1)
	{
		Halt();                            // wait for the V-blank
		g_Music_Update();                  // the song, the effect over it, the PSG

		u8 keys = ReadKeys();
		u8 pushed = keys & ~held;          // down this frame, not held from before
		held = keys;

		if (pushed & K_PICKUP)
			g_Sfx_Play(G_SFX_PICKUP);      // refused while the explosion sounds
		if (pushed & K_BOOM)
			g_Sfx_Play(G_SFX_EXPLOSION);
		if (pushed & K_JINGLE)
			g_Music_PlayJingle(g_Music_Fanfare);
		if (pushed & K_PAUSE)
		{
			if (paused)
			{
				paused = FALSE;
				g_Music_Resume();
			}
			else if (g_Music_IsPlaying())
			{
				paused = TRUE;
				g_Music_Pause();
			}
		}
		if (pushed & K_FADE)
			g_Music_FadeOut(4);
		if (pushed & K_MUSIC)
		{
			paused = FALSE;
			g_Music_Play(g_Music_Theme, TRUE);
		}

		Print_SetPosition(2, 13);
		if (g_Music_IsJingle())
			Print_DrawText("Jingle! ");
		else if (paused)
			Print_DrawText("Paused  ");
		else if (g_Music_IsPlaying())
			Print_DrawText("Playing ");
		else
			Print_DrawText("Stopped ");
	}
}
```

Replace `main.c` with this and press **Run**. The build exports both banks first
— `content/music.h` and `content/sfx.h` are written from the resources every
time — so there is nothing else to do.

## Walking through it

### Two headers, two players

Each bank's header holds its data and, because *Export ready-made C* is ticked,
a small player for it, declared with a comment on every call. Open
`content/music.h` after a build to see them; the [Resources](../resources.md)
guide lists them all under *Sound effects and music*.

`g_Sfx_Init()` hands MSXgl's ayFX player the bank and the channel the SFX
editor chose, with nothing playing. Call it before anything else touches sound:
a ROM's RAM is not cleared at boot, and ayFX's state starts as whatever happened
to be there. `g_Music_Play(song, loop)` starts a song from the top; with `TRUE`
it goes round from the song's **Loop bar** for ever, with `FALSE` it plays once.

### One call per frame

```c
Halt();
g_Music_Update();
```

`Halt()` sleeps until the V-blank interrupt (that is what
`VDP_EnableVBlank(TRUE)` turns on), so the loop runs once per frame, and
`g_Music_Update()` is the frame's sound: one frame of the song into the
register buffer, then the sound effect over its channel, then the buffer out to
the chip. Call it exactly once per frame. The song's tempo *is* the call rate —
a song made at 50 Hz plays 20% fast on a 60 Hz machine — and the music bank's
`_Update()` already runs the effects, so a game with music never calls
`g_Sfx_Update()` as well. (A game with effects and no music calls only
`g_Sfx_Update()`.)

### Effects and priorities

`g_Sfx_Play(G_SFX_PICKUP)` starts the effect on the next `_Update()`, on channel
C. While it plays it has channel C to itself — the song's part there drops out —
and the frame after it ends the song has its channel back, at the right pitch,
because the helper keeps a copy of the song's own registers. Press X, then SPACE before the explosion ends: the
pickup is refused, because the explosion's priority (2) matters more than the
pickup's (8). `g_Sfx_Play()` returns 1 when that happens, if the game wants to
know.

### The jingle

```c
g_Music_PlayJingle(g_Music_Fanfare);
```

The theme stops where it is, the fanfare plays once, and the frame the fanfare
ends the theme carries on from the exact spot it stopped — no restart, no gap.
`g_Music_IsJingle()` is `TRUE` until then, which is what the status line uses;
a stage-clear screen would wait on it:

```c
g_Music_PlayJingle(g_Music_Fanfare);
while (g_Music_IsJingle())
{
	Halt();
	g_Music_Update();
}
```

Try the combinations: pause the song, then press J — the jingle plays, and the
song is still paused afterwards until P. Press F, and J before the fade ends —
the jingle plays at full volume, and the fade carries on from where it was
afterwards. Press J during a jingle — the new one replaces it, and the song
still comes back. Effects play over a jingle exactly as over a song.

### Pause, resume, fade

`g_Music_Pause()` silences the music where it is and `g_Music_Resume()` carries
on from that frame. `g_Music_FadeOut(4)` lowers the volume one step every four
frames, fifteen steps in all — about a second — then stops the song:
`g_Music_IsPlaying()` turns `FALSE` and the status line says *Stopped*. After a
stop there is nothing to resume — `g_Music_Resume()` does nothing then, and the
program only pauses what is playing — so M starts the song again with
`g_Music_Play()`.

### Reading keys once per press

`Keyboard_IsKeyPressed()` says whether a key is *down*, and a key stays down for
several frames — a held J would restart the jingle every frame. Keeping last
frame's keys in `held` and acting on `keys & ~held` turns each press into one
event.

## Try changing it

- Make the jingle wait: replace the `K_JINGLE` line with the `while
  (g_Music_IsJingle())` loop above, then print *Stage clear!* after it.
- Change the song with no jingle at all: `g_Music_Play(g_Music_Fanfare, FALSE)`
  plays the fanfare once and leaves silence — the status line shows *Stopped* when
  it ends.
- Move the effects to channel A in the SFX editor and press X: now the melody
  drops out instead of the drums. Choose the channel whose loss is least
  noticed.
- Give the pickup priority 0 and the explosion 8, and the pickups cut the
  explosions off instead.

## Doing it without the helpers

The ready-made C calls MSXgl's own players; there is nothing in it you could not
write. For effects alone, that is the ayFX player, as in `s_ayfx.c`:

```c
ayFX_InitBank((void*)g_Sfx);
ayFX_SetChannel(PSG_CHANNEL_C);
ayFX_PlayBank(G_SFX_PICKUP, 8);
// each frame:
ayFX_Update();
PSG_Apply();
```

and for music alone, the lVGM player, as in `s_lvgm.c`:

```c
LVGM_Play(g_Music_Theme, TRUE);
// each frame:
LVGM_Decode();
PSG_Apply();
```

Put the two together by hand and you meet the problem the helper solves: lVGM
writes only the registers that *change*, so when an effect ends, its channel keeps
the effect's last pitch and volume until the song next happens to rewrite them —
a held note can stay wrong for a whole bar. The helper keeps a copy of the song's
registers and restores it before each decode. Jingles are the same story: there
is one lVGM player, and a second `LVGM_Play()` loses the song's place for good,
where `g_Music_PlayJingle()` sets it aside and puts it back.

## Gotchas

- **`Undefined Global _PT3_Regs`** at link time: `msxgl_config.h` still has the
  template's `AYFX_BUFFER_PT3`. Press **Set up project** in the music editor.
- **`#error "The music helpers need PSG_ACCESS PSG_INDIRECT…"`**: the helper
  keeps the song in `g_PSG_Regs`, which only exists in indirect mode — the
  template's default. Put it back in `msxgl_config.h`.
- **No `Halt()` wake-up, so no sound and a frozen screen**: `VDP_EnableVBlank(TRUE)`
  is missing — `Halt()` waits for an interrupt that never comes.
- **Two `_Update()`s per frame** play everything at double speed. With music,
  only `g_Music_Update()`.
- **Silent in openMSX on Linux, though the editor plays fine?** That is the
  system, not the game: see *No sound from openMSX on Linux* in
  [Troubleshooting](../troubleshooting.md).

Back: [SCREEN 3, chunky graphics](10-screen3-chunky.md) · All: [the tutorials](README.md)
