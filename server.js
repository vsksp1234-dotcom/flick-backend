const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');

const app = express();
app.use(cors());
const upload = multer({ dest: 'uploads/' });

const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY;

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('output')) fs.mkdirSync('output');

app.use('/output', express.static('output'));

async function transcribe(audioPath) {
  const audioData = fs.readFileSync(audioPath);
  const uploadRes = await axios.post(
    'https://api.assemblyai.com/v2/upload',
    audioData,
    { headers: { authorization: ASSEMBLYAI_KEY, 'content-type': 'application/octet-stream' } }
  );
  const audioUrl = uploadRes.data.upload_url;

  const transcriptRes = await axios.post(
    'https://api.assemblyai.com/v2/transcript',
    { audio_url: audioUrl },
    { headers: { authorization: ASSEMBLYAI_KEY } }
  );
  const transcriptId = transcriptRes.data.id;

  let transcript;
  while (true) {
    const poll = await axios.get(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      { headers: { authorization: ASSEMBLYAI_KEY } }
    );
    if (poll.data.status === 'completed') { transcript = poll.data; break; }
    if (poll.data.status === 'error') throw new Error(poll.data.error);
    await new Promise(r => setTimeout(r, 3000));
  }
  return transcript;
}

function buildSrt(transcript, outPath) {
  let srt = '';
  transcript.words.forEach((w, i) => {
    const start = msToSrtTime(w.start);
    const end = msToSrtTime(w.end);
    srt += `${i + 1}\n${start} --> ${end}\n${w.text}\n\n`;
  });
  fs.writeFileSync(outPath, srt);
}

function msToSrtTime(ms) {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const msRem = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${msRem}`;
}

app.post('/process', upload.single('video'), async (req, res) => {
  const videoPath = req.file.path;
  const jobId = req.file.filename;
  const audioPath = `uploads/${jobId}.mp3`;
  const srtPath = `uploads/${jobId}.srt`;
  const outputPath = `output/${jobId}.mp4`;
  const quality = req.body.quality || '1080';

  try {
    execSync(`ffmpeg -i ${videoPath} -vn -acodec mp3 ${audioPath}`);

    const transcript = await transcribe(audioPath);
    buildSrt(transcript, srtPath);

    const scaleMap = { '240': '426:240', '720': '1280:720', '1080': '1920:1080', '4k': '3840:2160' };
    const scale = scaleMap[quality] || scaleMap['1080'];

    execSync(
      `ffmpeg -i ${videoPath} -vf "scale=${scale},subtitles=${srtPath}:force_style='Fontsize=24,PrimaryColour=&H0AD9F5&,Bold=1'" -c:a copy ${outputPath}`
    );

    res.json({ success: true, downloadUrl: `/output/${jobId}.mp4` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Flick backend running on port ${PORT}`));
    
