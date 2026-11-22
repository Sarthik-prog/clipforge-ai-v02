import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { pipeline, env } from '@huggingface/transformers';
import { Upload, Film, Scissors, Captions, Download, Sparkles, Play, Clock3, Languages, AlertCircle, LoaderCircle, Trash2, ExternalLink } from 'lucide-react';

env.allowLocalModels = false;
env.useBrowserCache = true;

const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const MODEL = 'Xenova/whisper-tiny';

function formatTime(value) {
  const n = Math.max(0, Number(value) || 0);
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function parseWav(buffer) {
  const view = new DataView(buffer);
  let offset = 12, dataOffset = -1, dataSize = 0, format = 1, bits = 16, channels = 1;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(...new Uint8Array(buffer, offset, 4));
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      bits = view.getUint16(offset + 22, true);
    }
    if (id === 'data') { dataOffset = offset + 8; dataSize = size; break; }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0 || format !== 1 || bits !== 16) throw new Error('Could not read the audio WAV. Try a shorter or different video.');
  const count = Math.floor(dataSize / (2 * channels));
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += view.getInt16(dataOffset + (i * channels + c) * 2, true) / 32768;
    samples[i] = sum / channels;
  }
  return samples;
}
function makeSrt(captions) {
  return captions.map((c, i) => {
    const stamp = (v) => {
      const ms = Math.max(0, Math.round(v * 1000));
      const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000), milli = ms % 1000;
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(milli).padStart(3,'0')}`;
    };
    return `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`;
  }).join('\n');
}

export default function App() {
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [status, setStatus] = useState('Ready when you are');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [captions, setCaptions] = useState([]);
  const [language, setLanguage] = useState('auto');
  const [modelReady, setModelReady] = useState(false);
  const [outputUrl, setOutputUrl] = useState('');
  const [error, setError] = useState('');
  const ffmpegRef = useRef(null);
  const asrRef = useRef(null);
  const videoRef = useRef(null);
  const activeUrlRef = useRef('');
  const clipDuration = Math.max(0, end - start);
  const canWork = Boolean(file) && !busy;

  useEffect(() => () => {
    if (activeUrlRef.current) URL.revokeObjectURL(activeUrlRef.current);
    if (outputUrl) URL.revokeObjectURL(outputUrl);
  }, [outputUrl]);

  function chooseFile(next) {
    if (!next) return;
    if (!next.type.startsWith('video/')) { setError('Please choose a video file.'); return; }
    if (next.size > 700 * 1024 * 1024) { setError('This phone-friendly version limits uploads to 700 MB. Try a shorter or smaller video.'); return; }
    setError('');
    if (activeUrlRef.current) URL.revokeObjectURL(activeUrlRef.current);
    const nextUrl = URL.createObjectURL(next);
    activeUrlRef.current = nextUrl;
    setFile(next); setUrl(nextUrl); setCaptions([]); setOutputUrl(''); setProgress(0);
    setStart(0); setEnd(0); setStatus('Video ready. Set your clip range.');
  }
  function onVideoMeta() {
    const d = videoRef.current?.duration || 0;
    setDuration(d); setEnd(d);
  }
  async function getFFmpeg() {
    if (ffmpegRef.current) return ffmpegRef.current;
    setStatus('Loading video engine for the first time…');
    const ff = new FFmpeg();
    ff.on('progress', ({ progress: p }) => setProgress(Math.max(0, Math.min(100, Math.round(p * 100)))));
    ff.on('log', ({ message }) => { if (message) setStatus(message.slice(0, 110)); });
    await ff.load({
      coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, 'application/wasm')
    });
    ffmpegRef.current = ff;
    return ff;
  }
  async function transcribe() {
    if (!file || busy) return;
    setBusy(true); setError(''); setProgress(0);
    try {
      const ff = await getFFmpeg();
      setStatus('Preparing audio for captions…');
      await ff.writeFile('source-video', await fetchFile(file));
      const code = await ff.exec(['-i', 'source-video', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', 'audio.wav']);
      if (code !== 0) throw new Error('Audio extraction failed. Try another video format.');
      const wav = await ff.readFile('audio.wav');
      const samples = parseWav(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
      if (!asrRef.current) {
        setStatus('Downloading the speech model. First use can take a few minutes…');
        asrRef.current = await pipeline('automatic-speech-recognition', MODEL, {
          progress_callback: (p) => { if (p.status === 'progress' && p.file) setStatus(`Downloading speech model: ${p.file}`); }
        });
      }
      setModelReady(true);
      setStatus('Listening to your video. This runs on your device…');
      const options = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true };
      if (language !== 'auto') options.language = language;
      options.task = 'transcribe';
      const result = await asrRef.current(samples, options);
      const chunks = (result.chunks || []).filter(x => x.text?.trim()).map((x, i) => ({
        id: `${Date.now()}-${i}`,
        start: Array.isArray(x.timestamp) ? (x.timestamp[0] || 0) : 0,
        end: Array.isArray(x.timestamp) ? (x.timestamp[1] || ((x.timestamp[0] || 0) + 3)) : 3,
        text: x.text.trim()
      }));
      if (chunks.length) setCaptions(chunks);
      else if (result.text?.trim()) setCaptions([{ id: String(Date.now()), start: 0, end: Math.min(duration || 5, 5), text: result.text.trim() }]);
      else throw new Error('No speech was detected. You can still export the video clip.');
      setStatus('Captions created. Review and edit the text below.');
    } catch (e) {
      setError(e?.message || 'Caption generation failed.'); setStatus('Something needs attention.');
    } finally { setBusy(false); setProgress(0); }
  }
  async function exportClip() {
    if (!file || busy || end <= start) return;
    setBusy(true); setError(''); setProgress(0);
    try {
      const ff = await getFFmpeg();
      setStatus('Preparing your vertical MP4…');
      await ff.writeFile('clip-input', await fetchFile(file));
      const code = await ff.exec([
        '-ss', String(start), '-i', 'clip-input', '-t', String(end - start),
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', 'clipforge-short.mp4'
      ]);
      if (code !== 0) throw new Error('Export did not finish. This video may be too large for your phone, or the browser may have run out of memory. Try a shorter clip.');
      const data = await ff.readFile('clipforge-short.mp4');
      const blob = new Blob([data], { type: 'video/mp4' });
      const next = URL.createObjectURL(blob);
      setOutputUrl(next); setStatus('MP4 export complete. Your captions can be downloaded as an SRT file.');
    } catch (e) { setError(e?.message || 'Export failed.'); setStatus('Export failed.'); }
    finally { setBusy(false); setProgress(0); }
  }
  function updateCaption(id, field, value) {
    setCaptions(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
  }
  function downloadSrt() {
    const blob = new Blob([makeSrt(captions)], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'clipforge-captions.srt'; a.click(); URL.revokeObjectURL(a.href);
  }
  const activeCaption = useMemo(() => captions.find(c => videoRef.current && videoRef.current.currentTime >= c.start && videoRef.current.currentTime <= c.end), [captions]);
  const subtitlePreview = activeCaption?.text || '';

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" aria-label="ClipForge home"><span className="brand-mark"><Film size={21}/></span><span>ClipForge <b>AI</b><small>CREATOR STUDIO</small></span></a>
      <span className="version">BETA 0.2</span>
    </header>
    <main>
      <section className="hero">
        <div className="eyebrow"><Sparkles size={14}/> YOUR STREAM. YOUR BEST MOMENTS.</div>
        <h1>Turn long videos into<br/><span>scroll-stopping clips.</span></h1>
        <p>Upload a video, find your moment, create captions and export a vertical Short. Processing stays in your browser.</p>
      </section>

      <section className="panel upload-panel">
        <div className="section-head"><div><span className="step">01</span><h2>Bring your video</h2></div><span className="muted">MP4 · MOV · WEBM</span></div>
        <label className="dropzone">
          <input type="file" accept="video/*" onChange={e => chooseFile(e.target.files?.[0])}/>
          <span className="upload-icon"><Upload size={24}/></span>
          <strong>{file ? file.name : 'Tap to upload a video'}</strong>
          <span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · selected` : 'Choose a file from your phone · max 700 MB'}</span>
        </label>
        <div className="youtube-note"><ExternalLink size={15}/><span>YouTube links are not downloaded here. Upload a video you own or have permission to edit.</span></div>
      </section>

      {file && <section className="panel editor-panel">
        <div className="section-head"><div><span className="step">02</span><h2>Choose your moment</h2></div><span className="muted">{formatTime(duration)} total</span></div>
        <div className="preview-wrap">
          <video ref={videoRef} src={url} controls playsInline onLoadedMetadata={onVideoMeta} onTimeUpdate={() => setProgress(p => p)} />
          {subtitlePreview && <div className="subtitle-preview">{subtitlePreview}</div>}
        </div>
        <div className="range-grid">
          <label><span>START TIME</span><input type="number" min="0" max={duration || 0} step="0.5" value={start} onChange={e => setStart(Math.max(0, Math.min(Number(e.target.value), end - 0.5)))}/></label>
          <label><span>END TIME</span><input type="number" min={start + 0.5} max={duration || 0} step="0.5" value={end} onChange={e => setEnd(Math.max(start + 0.5, Math.min(Number(e.target.value), duration || Number(e.target.value))))}/></label>
          <div className="duration-box"><Clock3 size={16}/><b>{formatTime(clipDuration)}</b><small>clip length</small></div>
        </div>
        <div className="range-actions">
          <button className="secondary-btn" onClick={() => videoRef.current && (videoRef.current.currentTime = start)}><Play size={15}/> Preview start</button>
          <button className="secondary-btn" onClick={() => {setStart(0);setEnd(duration);}}>Use full video</button>
        </div>
      </section>}

      {file && <section className="panel captions-panel">
        <div className="section-head"><div><span className="step">03</span><h2>Auto captions</h2></div><span className="muted"><Languages size={14}/> Hindi + English</span></div>
        <p className="panel-copy">Speech recognition runs on your device. The first model download is large and may be slow on mobile data.</p>
        <div className="caption-controls">
          <select value={language} onChange={e => setLanguage(e.target.value)} disabled={busy}>
            <option value="auto">Detect language</option><option value="english">English</option><option value="hindi">Hindi</option>
          </select>
          <button className="primary-btn" onClick={transcribe} disabled={!canWork}><Captions size={17}/>{busy ? 'Working…' : 'Generate captions'}</button>
        </div>
        {modelReady && <div className="model-status"><span className="dot"/> Speech model loaded in this browser</div>}
        {captions.length > 0 && <div className="caption-list">
          <div className="caption-list-head"><b>{captions.length} caption segments</b><button className="text-btn" onClick={downloadSrt}><Download size={14}/> Download SRT</button></div>
          {captions.map((c, i) => <div className="caption-row" key={c.id}>
            <span className="caption-index">{String(i + 1).padStart(2,'0')}</span>
            <div className="caption-edit"><small>{formatTime(c.start)} – {formatTime(c.end)}</small><textarea value={c.text} rows={2} onChange={e => updateCaption(c.id, 'text', e.target.value)}/></div>
            <button className="icon-btn" title="Remove caption" onClick={() => setCaptions(prev => prev.filter(x => x.id !== c.id))}><Trash2 size={15}/></button>
          </div>)}
        </div>}
      </section>}

      {file && <section className="panel export-panel">
        <div className="section-head"><div><span className="step">04</span><h2>Export your Short</h2></div><span className="format-tag">9:16 · MP4</span></div>
        <p className="panel-copy">Creates a vertical 1080 × 1920 MP4. Captions download separately as an editable SRT file.</p>
        <button className="export-btn" onClick={exportClip} disabled={!canWork || clipDuration <= 0}><Scissors size={18}/>{busy ? 'Processing video…' : 'Export vertical MP4'}<Download size={17}/></button>
        {busy && <div className="progress-wrap"><div className="progress-bar"><span style={{width: progress ? `${progress}%` : '8%'}}/></div><small>{status}</small></div>}
        {outputUrl && <div className="download-result"><b>Your clip is ready</b><a href={outputUrl} download="clipforge-short.mp4"><Download size={16}/> Save MP4</a></div>}
      </section>}

      {!file && <section className="how-grid">
        <div><Scissors/><b>Pick a moment</b><span>Set your own start and end points.</span></div>
        <div><Captions/><b>Make captions</b><span>Generate Hindi or English subtitles.</span></div>
        <div><Download/><b>Export vertical</b><span>Save a 9:16 MP4 for Shorts.</span></div>
      </section>}

      <section className="status-line">{error ? <><AlertCircle size={16}/><span>{error}</span></> : <><span className="status-dot"/><span>{status}</span></>}</section>
      <p className="privacy-note">Your video is processed in this browser. It is not uploaded to a ClipForge server. Keep this tab open while processing.</p>
    </main>
    <footer>CLIPFORGE AI <span>·</span> MADE FOR CREATORS</footer>
  </div>;
}
