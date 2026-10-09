# Explainer films

Three short films, each in English and Swedish, that explain what Eir is, how it works technically and how
to contribute. They are made entirely with code from this folder, so anyone can fix a sentence, translate
them to a new language or add a film with a pull request.

| Film                | English                               | Swedish                             |
| ------------------- | ------------------------------------- | ----------------------------------- |
| What Eir is and why | `narration/01-what-and-why.yaml`      | `narration/01-vad-och-varfor.yaml`  |
| How it works        | `narration/02-how-it-works.yaml`      | `narration/02-sa-fungerar-det.yaml` |
| How to contribute   | `narration/03-how-to-contribute.yaml` | `narration/03-sa-bidrar-du.yaml`    |

## How a film is made

1. **Scenes** (`scenes/*.html`) are plain HTML, CSS and SVG. `scenes/runtime.js` makes every scene a pure
   function of time, so any frame can be rendered exactly, in any order.
2. **Narration** (`narration/*.yaml`) lists the scenes and the sentences spoken in each. Optional `say:`
   overrides how a sentence is pronounced without changing the caption. `pronunciation.yaml` holds
   word-level fixes.
3. **Speech** is synthesized locally and offline: Kokoro for English, Supertonic for Swedish. ElevenLabs is
   optional (`VIDEO_TTS=elevenlabs`, `ELEVENLABS_API_KEY` in the environment, never in a file). Lines are
   cached by a hash of everything that affects the sound.
4. **Timing** comes from the audio: Parakeet aligns every word, so captions are highlighted as they are
   spoken and each scene lasts as long as its narration needs.
5. **Rendering** captures frames with Playwright and joins the scene clips with ffmpeg crossfades.
6. **Music** (`music.py`) is an original ambient pad generated from code, mixed low and eased down gently
   while someone speaks (`audio-mix.ts`). Pass `--no-music` to leave it out.
7. **Text on screen** lives in `locales/en.yaml` and `locales/sv.yaml`. Both must define the same keys.

The look follows the Eir design system and eir.space: a light theme by default, `--theme dark` for the dark one.

## Run it

```sh
npm run video:prepare                           # Lucide icons, and Eir logos from ../eir-design-system
npm run video:build -- 01-what-and-why          # a whole film -> video/out/<id>/<id>.mp4
npm run video:build -- 01-what-and-why --still title 6   # one still frame, to check a layout fast
npm run video:remix -- 01-what-and-why          # redo only the music mix, keep the picture
npm run video:publish                           # small web versions, captions and posters -> video/publish
```

Set `VIDEO_TTS_PYTHON` (and `VIDEO_STT_PYTHON`) to a Python that has `mlx-audio`, `supertonic` and
`parakeet-mlx`. You need `ffmpeg` and Playwright's Chromium. Everything runs offline once the models are cached.
`--check` runs a speech-recognition pass over the narration and prints a word error rate as advice.

## Add a language

Copy `locales/en.yaml` to `locales/<lang>.yaml`, translate the values, then copy a narration file, set
`language: <lang>` and translate the sentences. Use a different `id`. Say which voice you used.

## Publish to the site

The site is static files on Firebase Hosting. `npm run hosting:prepare` copies `video/publish/` to `/video/`
(the folder is not committed because the files are large). The page that plays them is the "Watch" section of
`apps/web/guide.html`, driven by `apps/web/film.js`. The site's content policy allows only same-origin
media, so the films are not embedded from a third-party video host.

## Rules

Synthetic data only. Never show real patient information or a real national connection that has not passed an
authorized test environment. Brand assets from the design system are not redistributed here: `prepare` copies
them from your own clone into `video/assets/`, which is ignored by git.
