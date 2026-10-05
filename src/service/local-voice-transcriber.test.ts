import test from "node:test";
import assert from "node:assert/strict";
import { transcribeLocalVoice } from "./local-voice-transcriber.js";

test("local voice transcription passes paths as arguments and parses only transcript JSON", async () => {
  const transcript = await transcribeLocalVoice("/tmp/voice $(unsafe).ogg", {
    voiceWhisperPythonBin: "/venv/bin/python", voiceWhisperModel: "small", voiceWhisperLanguage: "en"
  }, async (bin, args, options) => {
    assert.equal(bin, "/venv/bin/python");
    assert.deepEqual(args.slice(2), ["/tmp/voice $(unsafe).ogg", "small", "en"]);
    assert.equal(options.timeout, 180_000);
    assert.equal(options.killSignal, "SIGKILL");
    return { stdout: '{"text":"  Hello from a voice note.  "}\n' };
  });
  assert.equal(transcript, "Hello from a voice note.");
});

test("local voice transcription rejects silence and malformed output", async () => {
  for (const stdout of ['{"text":""}', '{"text":42}', 'not JSON']) {
    await assert.rejects(transcribeLocalVoice("voice.ogg", {}, async () => ({ stdout })), /No speech|invalid transcription/);
  }
});

test("local voice transcription reports missing Python and timeouts", async () => {
  await assert.rejects(transcribeLocalVoice("voice.ogg", {}, async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }), /Check VOICE_WHISPER_PYTHON_BIN/);
  await assert.rejects(transcribeLocalVoice("voice.ogg", {}, async () => {
    throw Object.assign(new Error("timeout"), { killed: true });
  }), /180-second/);
});


test("English voice transcription defaults to English and rejects mixed-script gibberish", async () => {
  await assert.rejects(transcribeLocalVoice("voice.ogg", {}, async (_bin, args) => {
    assert.equal(args[4], "en");
    return { stdout: JSON.stringify({ text: "лиз థసిర్వస ఎపెకంనంరారంచివిలూకాక වවවද්ඛ්ඛ් of time" }) };
  }), /garbled text/);
  assert.equal(await transcribeLocalVoice("voice.ogg", {}, async () => ({ stdout: JSON.stringify({text: "Please review José’s project."}) })), "Please review José’s project.");
});
