const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('./index');

const silenceWav = (durationMs = 500) => {
  const sampleRate = 16000;
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = samples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // audio format PCM
  buffer.writeUInt16LE(1, 22); // channels
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  // data section already zeroed for silence
  return buffer;
};

test('baseline endpoints without session', async () => {
  await request(app).post('/api/session/end');
  const status = await request(app).get('/api/status');
  assert.strictEqual(status.status, 200);
  assert.strictEqual(status.body.sessionActive, false);
  assert.ok(Array.isArray(status.body.transcripts));
  assert.ok(Array.isArray(status.body.images));

  const ping = await request(app).post('/api/ping').send({});
  assert.strictEqual(ping.status, 400);
  assert.strictEqual(ping.body.error, 'API key is required');

  const start = await request(app).post('/api/session/start').send({});
  assert.strictEqual(start.status, 400);
  assert.strictEqual(start.body.error, 'API key is required to start a session');

  const audio = await request(app)
    .post('/api/audio')
    .attach('audio', Buffer.from('test'), 'chunk.webm');
  assert.strictEqual(audio.status, 400);
  assert.strictEqual(audio.body.error, 'No active session');

  const generate = await request(app).post('/api/generate');
  assert.strictEqual(generate.status, 400);
  assert.strictEqual(generate.body.error, 'No active session');
});

test('mock end-to-end audio -> transcript -> generate', async () => {
  await request(app).post('/api/session/end');
  const start = await request(app).post('/api/session/start').send({
    apiKey: 'sk-test',
    languageMode: 'english',
    workshopType: 'Test',
    imageSize: '1024x1024',
    stylePreset: 'Test style',
    phase: 'Vision',
  });
  assert.strictEqual(start.status, 200);

  const audioRes = await request(app)
    .post('/api/audio')
    .attach('audio', silenceWav(), { filename: 'chunk.wav', contentType: 'audio/wav' });
  assert.strictEqual(audioRes.status, 200);
  assert.strictEqual(audioRes.body.text, 'mock transcript');

  const genRes = await request(app).post('/api/generate');
  assert.strictEqual(genRes.status, 200);
  assert.ok(genRes.body.image);
  assert.ok(genRes.body.image.url);

  const statusAfter = await request(app).get('/api/status');
  assert.strictEqual(statusAfter.body.sessionActive, true);
  assert.ok(statusAfter.body.transcripts.length >= 1);
  assert.ok(statusAfter.body.images.length >= 1);

  await request(app).post('/api/session/end');
});
