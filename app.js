/**
 * AoneSite — app.js
 * Fluxo: File Upload → FFmpeg.wasm (extração MP3) → Base64 → Gemini API → Transcrição
 *
 * Arquivos de áudio (mp3, wav, etc.) pulam a etapa do FFmpeg e vão direto para Base64.
 * Arquivos grandes (> 19 MB em Base64) usam a File Upload API do Gemini.
 */

import { FFmpeg } from 'https://esm.sh/@ffmpeg/ffmpeg@0.12.10';
import { fetchFile } from 'https://esm.sh/@ffmpeg/util@0.12.1';

// ─── Constantes ───────────────────────────────────────────────────────────────

const GEMINI_MODEL        = 'gemini-2.5-flash';
const GEMINI_API_BASE     = 'https://generativelanguage.googleapis.com/v1beta';
const INLINE_SIZE_LIMIT   = 19 * 1024 * 1024; // 19 MB (base64 ~25% maior)
const AUDIO_MIME_TYPES    = new Set(['audio/mpeg','audio/mp3','audio/wav','audio/x-wav',
                                     'audio/ogg','audio/flac','audio/m4a','audio/mp4',
                                     'audio/aac','audio/webm']);

// MIME types que o Gemini aceita para áudio inline / file upload
const GEMINI_AUDIO_MIMES = {
  'audio/mpeg': 'audio/mp3',
  'audio/mp3':  'audio/mp3',
  'audio/wav':  'audio/wav',
  'audio/x-wav':'audio/wav',
  'audio/ogg':  'audio/ogg',
  'audio/flac': 'audio/flac',
  'audio/m4a':  'audio/m4a',
  'audio/mp4':  'audio/mp4',
  'audio/aac':  'audio/aac',
  'audio/webm': 'audio/webm',
};

// ─── Estado Global ────────────────────────────────────────────────────────────

const state = {
  apiKey:  null,
  file:    null,
  ffmpeg:  null,
  ffmpegReady: false,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const dom = {
  // API Key
  apiKeyToggle:   $('apiKeyToggle'),
  apiKeyBody:     $('apiKeyBody'),
  apiChevron:     $('apiChevron'),
  apiKeyDot:      $('apiKeyDot'),
  apiKeyInput:    $('apiKeyInput'),
  toggleVis:      $('toggleVisibility'),
  eyeIcon:        $('eyeIcon'),
  saveApiKey:     $('saveApiKey'),
  clearApiKey:    $('clearApiKey'),
  keyFeedback:    $('keyFeedback'),
  // Upload
  dropZone:       $('dropZone'),
  fileInput:      $('fileInput'),
  filePreview:    $('filePreview'),
  fileTypeBadge:  $('fileTypeBadge'),
  fileName:       $('fileName'),
  fileSize:       $('fileSize'),
  clearFile:      $('clearFile'),
  promptInput:    $('promptInput'),
  transcribeBtn:  $('transcribeBtn'),
  // Progress
  progressSection:$('progressSection'),
  step1:          $('step1'),
  step1Desc:      $('step1Desc'),
  step2:          $('step2'),
  step2Desc:      $('step2Desc'),
  step3:          $('step3'),
  step3Desc:      $('step3Desc'),
  progressFill:   $('progressFill'),
  progressMsg:    $('progressMsg'),
  // Results
  resultsSection: $('resultsSection'),
  wordCount:      $('wordCount'),
  transcriptionBox:$('transcriptionBox'),
  copyBtn:        $('copyBtn'),
  downloadBtn:    $('downloadBtn'),
  resetBtn:       $('resetBtn'),
  // Error
  errorToast:     $('errorToast'),
  errorMsg:       $('errorMsg'),
  closeToast:     $('closeToast'),
};

// ─── Inicialização ────────────────────────────────────────────────────────────

function init() {
  loadSavedApiKey();
  attachEvents();
  // Pré-carrega FFmpeg em background (opcional, melhora UX)
  loadFFmpeg().catch(() => {});
}

// ─── API Key Management ───────────────────────────────────────────────────────

function loadSavedApiKey() {
  const saved = localStorage.getItem('gemini_api_key');
  if (saved) {
    state.apiKey = saved;
    dom.apiKeyInput.value = saved;
    setDotActive(true);
  }
}

function saveApiKey() {
  const val = dom.apiKeyInput.value.trim();
  if (!val || !val.startsWith('AIza')) {
    showKeyFeedback('Chave inválida. Deve começar com "AIza".', 'err');
    return;
  }
  state.apiKey = val;
  localStorage.setItem('gemini_api_key', val);
  setDotActive(true);
  showKeyFeedback('✓ Chave salva com sucesso.', 'ok');
  // Auto-colapsa após salvar
  setTimeout(() => collapseApiCard(), 1200);
}

function clearApiKey() {
  state.apiKey = null;
  dom.apiKeyInput.value = '';
  localStorage.removeItem('gemini_api_key');
  setDotActive(false);
  showKeyFeedback('Chave removida.', 'err');
}

function setDotActive(active) {
  dom.apiKeyDot.classList.toggle('active', active);
  dom.apiKeyDot.title = active ? 'API Key configurada' : 'Sem chave configurada';
}

function showKeyFeedback(msg, type) {
  dom.keyFeedback.textContent = msg;
  dom.keyFeedback.className = 'key-feedback ' + type;
  setTimeout(() => { dom.keyFeedback.textContent = ''; dom.keyFeedback.className = 'key-feedback'; }, 4000);
}

function collapseApiCard() {
  dom.apiKeyBody.classList.add('collapsed');
  dom.apiChevron.classList.remove('open');
  dom.apiKeyToggle.setAttribute('aria-expanded', 'false');
}

// ─── FFmpeg ───────────────────────────────────────────────────────────────────

async function loadFFmpeg() {
  if (state.ffmpegReady) return state.ffmpeg;

  state.ffmpeg = new FFmpeg();

  state.ffmpeg.on('log', ({ message }) => {
    // Filtra linhas de log relevantes para o usuário
    if (dom.progressSection && !dom.progressSection.classList.contains('hidden')) {
      const clean = message.replace(/^\[.*?\]\s*/, '');
      if (clean.length > 2 && clean.length < 100) {
        dom.progressMsg.textContent = clean;
      }
    }
  });

  state.ffmpeg.on('progress', ({ progress }) => {
    if (progress > 0 && progress <= 1) {
      setProgress(10 + Math.round(progress * 55), null);
    }
  });

  // Usa o core single-threaded para não precisar de COOP/COEP
  await state.ffmpeg.load({
    coreURL:  'https://unpkg.com/@ffmpeg/core-st@0.12.6/dist/esm/ffmpeg-core.js',
    wasmURL:  'https://unpkg.com/@ffmpeg/core-st@0.12.6/dist/esm/ffmpeg-core.wasm',
  });

  state.ffmpegReady = true;
  return state.ffmpeg;
}

async function extractAudioAsMP3(file) {
  const ff = await loadFFmpeg();
  const inputName = 'input' + getExtension(file.name);
  const outputName = 'output.mp3';

  await ff.writeFile(inputName, await fetchFile(file));
  await ff.exec([
    '-i', inputName,
    '-vn',                     // sem vídeo
    '-ar', '16000',            // 16 kHz — bom para STT
    '-ac', '1',                // mono
    '-b:a', '64k',             // 64 kbps (suficiente para fala)
    outputName,
  ]);

  const data = await ff.readFile(outputName);
  await ff.deleteFile(inputName);
  await ff.deleteFile(outputName);

  return new Blob([data.buffer], { type: 'audio/mp3' });
}

// ─── File Handling ────────────────────────────────────────────────────────────

function handleFileSelected(file) {
  if (!file) return;
  state.file = file;

  dom.fileTypeBadge.textContent = getExtension(file.name).replace('.', '').toUpperCase() || 'FILE';
  dom.fileName.textContent = file.name;
  dom.fileSize.textContent = formatBytes(file.size);

  dom.dropZone.classList.add('hidden');
  dom.filePreview.classList.remove('hidden');
}

function clearFileSelection() {
  state.file = null;
  dom.fileInput.value = '';
  dom.filePreview.classList.add('hidden');
  dom.dropZone.classList.remove('hidden');
}

// ─── Transcription Pipeline ───────────────────────────────────────────────────

async function startTranscription() {
  if (!state.apiKey) {
    showError('Configure sua API Key do Gemini antes de transcrever.');
    return;
  }
  if (!state.file) {
    showError('Selecione um arquivo de áudio ou vídeo.');
    return;
  }

  const prompt = dom.promptInput.value.trim() ||
    'Transcreva o áudio na íntegra, sem comentários adicionais.';

  // Mostra progress, esconde upload
  dom.filePreview.classList.add('hidden');
  dom.dropZone.classList.add('hidden');
  dom.progressSection.classList.remove('hidden');
  dom.resultsSection.classList.add('hidden');
  dom.transcribeBtn.disabled = true;

  try {
    // ── Passo 1: Extrair áudio ──────────────────────────────────────
    setStep(1, 'active');
    setProgress(5, 'Preparando arquivo…');

    let audioBlob;
    const isAudio = isAudioFile(state.file);

    if (isAudio) {
      // Já é áudio — usa diretamente
      setStep(1, 'active');
      dom.step1Desc.textContent = 'Arquivo de áudio detectado — pulando extração.';
      audioBlob = state.file;
      setProgress(35, 'Áudio carregado.');
    } else {
      // É vídeo — extrai com FFmpeg
      dom.step1Desc.textContent = 'Carregando FFmpeg.wasm…';
      setProgress(8, 'Inicializando FFmpeg.wasm (primeira vez pode demorar ~10s)…');
      audioBlob = await extractAudioAsMP3(state.file);
      dom.step1Desc.textContent = `MP3 extraído (${formatBytes(audioBlob.size)})`;
      setProgress(65, 'Áudio extraído com sucesso.');
    }

    setStep(1, 'done');

    // ── Passo 2: Codificar Base64 ───────────────────────────────────
    setStep(2, 'active');
    dom.step2Desc.textContent = 'Convertendo para Base64…';
    setProgress(70, 'Codificando áudio…');

    const { base64, mimeType } = await blobToBase64(audioBlob, isAudio ? state.file.type : 'audio/mp3');
    dom.step2Desc.textContent = `Base64 pronto (${formatBytes(Math.round(base64.length * 0.75))})`;
    setProgress(78, 'Codificação concluída.');
    setStep(2, 'done');

    // ── Passo 3: Gemini API ─────────────────────────────────────────
    setStep(3, 'active');
    dom.step3Desc.textContent = 'Enviando para Gemini AI…';
    setProgress(85, `Aguardando resposta do modelo ${GEMINI_MODEL}…`);

    let transcription;
    const rawSize = audioBlob.size;

    if (rawSize > INLINE_SIZE_LIMIT) {
      // Arquivo grande: usa File Upload API
      dom.step3Desc.textContent = 'Fazendo upload do arquivo (grande)…';
      setProgress(87, 'Upload de arquivo grande via File Upload API…');
      const fileUri = await uploadFileToGemini(audioBlob, mimeType);
      transcription = await generateFromFileUri(fileUri, mimeType, prompt);
    } else {
      // Inline base64
      transcription = await generateInline(base64, mimeType, prompt);
    }

    dom.step3Desc.textContent = 'Transcrição recebida!';
    setProgress(100, 'Concluído.');
    setStep(3, 'done');

    // ── Exibe resultado ─────────────────────────────────────────────
    setTimeout(() => showResults(transcription), 500);

  } catch (err) {
    console.error('[AoneSite] Erro na transcrição:', err);
    showError(err.message || 'Erro desconhecido. Verifique o console.');
    resetProgressUI();
  } finally {
    dom.transcribeBtn.disabled = false;
  }
}

// ─── Gemini API Calls ─────────────────────────────────────────────────────────

async function generateInline(base64, mimeType, prompt) {
  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${state.apiKey}`;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64 } },
        { text: prompt },
      ],
    }],
    generationConfig: { 
      temperature: 0.1,
      responseMimeType: "application/json"
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return parseGeminiResponse(await res.json(), res.ok);
}

async function uploadFileToGemini(blob, mimeType) {
  // Passo 1: inicia upload resumível
  const startRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${state.apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(blob.size),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'aonesite_audio' } }),
    }
  );

  if (!startRes.ok) throw new Error(`Erro ao iniciar upload: ${startRes.status}`);
  const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('URL de upload não recebida.');

  // Passo 2: envia o blob
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(blob.size),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: blob,
  });

  if (!uploadRes.ok) throw new Error(`Erro no upload do arquivo: ${uploadRes.status}`);
  const fileData = await uploadRes.json();
  return fileData.file?.uri;
}

async function generateFromFileUri(fileUri, mimeType, prompt) {
  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${state.apiKey}`;
  const body = {
    contents: [{
      parts: [
        { file_data: { mime_type: mimeType, file_uri: fileUri } },
        { text: prompt },
      ],
    }],
    generationConfig: { 
      temperature: 0.1,
      responseMimeType: "application/json"
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return parseGeminiResponse(await res.json(), res.ok);
}

function parseGeminiResponse(data, ok) {
  if (!ok) {
    const msg = data?.error?.message || 'Erro na API do Gemini.';
    throw new Error(msg);
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini não retornou texto. Verifique a API Key e o modelo.');
  
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('A resposta do Gemini não é um JSON válido. Tente refazer a instrução.');
  }
}

// ─── UI State ─────────────────────────────────────────────────────────────────

function setStep(num, status) {
  const el = dom[`step${num}`];
  el.classList.remove('active', 'done');
  if (status) el.classList.add(status);

  // Atualiza ícone do círculo se "done"
  const circle = el.querySelector('.step-circle span');
  if (status === 'done') circle.textContent = '✓';
}

function setProgress(pct, msg) {
  dom.progressFill.style.width = `${pct}%`;
  if (msg) dom.progressMsg.textContent = msg;
}

function showResults(data) {
  dom.progressSection.classList.add('hidden');

  dom.transcriptionBox.textContent = data.transcricao_diarizada || 'Nenhuma transcrição retornada.';
  
  const container = document.getElementById('studentsContainer');
  container.innerHTML = '';

  const alunos = data.alunos || [];
  if (alunos.length === 0) {
    container.innerHTML = '<p style="color: var(--text-dim); font-size: 0.85rem;">Nenhum aluno identificado.</p>';
  } else {
    alunos.forEach(aluno => {
      const card = document.createElement('div');
      card.className = 'student-card';
      
      const title = document.createElement('h4');
      title.textContent = aluno.nome;
      card.appendChild(title);
      
      const weakLabel = document.createElement('strong');
      weakLabel.textContent = 'Pontos a Melhorar:';
      card.appendChild(weakLabel);
      
      const weakList = document.createElement('ul');
      (aluno.pontos_fracos || []).forEach(pt => {
        const li = document.createElement('li');
        li.textContent = pt;
        weakList.appendChild(li);
      });
      card.appendChild(weakList);
      
      const exLabel = document.createElement('strong');
      exLabel.textContent = 'Exercícios Recomendados:';
      card.appendChild(exLabel);
      
      const exList = document.createElement('ul');
      (aluno.exercicios_recomendados || []).forEach(ex => {
        const li = document.createElement('li');
        li.textContent = ex;
        exList.appendChild(li);
      });
      card.appendChild(exList);
      
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-sm mt-2';
      btn.textContent = 'Gerar PDF deste Aluno';
      btn.onclick = () => generatePDF(aluno);
      card.appendChild(btn);
      
      container.appendChild(card);
    });
  }

  dom.resultsSection.classList.remove('hidden');
}

function generatePDF(aluno) {
  // Usa impressão nativa do browser (Ctrl+P → "Salvar como PDF").
  // Muito mais confiável que bibliotecas externas de canvas-to-pdf.
  const pontosHTML = (aluno.pontos_fracos || [])
    .map(p => `<li>${p}</li>`).join('');
  const exerciciosHTML = (aluno.exercicios_recomendados || [])
    .map(e => `<li>${e}</li>`).join('');

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"/>
  <title>Feedback — ${aluno.nome}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', Arial, sans-serif;
      color: #1e293b;
      background: #fff;
      padding: 48px 56px;
      max-width: 780px;
      margin: 0 auto;
    }

    .header {
      text-align: center;
      border-bottom: 3px solid #7c3aed;
      padding-bottom: 24px;
      margin-bottom: 36px;
    }

    .logo-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #7c3aed;
      margin-bottom: 10px;
    }

    h1 {
      font-size: 26px;
      font-weight: 700;
      color: #1e293b;
      margin-bottom: 6px;
    }

    .student-name {
      font-size: 15px;
      color: #64748b;
      font-weight: 400;
    }

    .section {
      margin-bottom: 32px;
    }

    h2 {
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      padding: 8px 14px;
      border-radius: 6px;
      margin-bottom: 14px;
    }

    .section-red h2  { color: #ef4444; background: #fef2f2; border-left: 4px solid #ef4444; }
    .section-green h2{ color: #059669; background: #f0fdf4; border-left: 4px solid #059669; }

    ul {
      padding-left: 20px;
      line-height: 1.8;
      font-size: 14px;
      color: #334155;
    }

    ul li { margin-bottom: 4px; }

    .footer {
      margin-top: 60px;
      padding-top: 18px;
      border-top: 1px solid #e2e8f0;
      text-align: center;
      font-size: 10px;
      color: #94a3b8;
    }

    @media print {
      body { padding: 24px 32px; }
      @page { margin: 1cm; }
    }
  </style>
</head>
<body>
  <div class="header">
    <p class="logo-label">AoneSite Teacher Assistant</p>
    <h1>English Performance Report</h1>
    <p class="student-name">Student: <strong>${aluno.nome}</strong></p>
  </div>

  <div class="section section-red">
    <h2>Areas for Improvement</h2>
    <ul>${pontosHTML}</ul>
  </div>

  <div class="section section-green">
    <h2>Recommended Practice</h2>
    <ul>${exerciciosHTML}</ul>
  </div>

  <div class="footer">
    Generated by AoneSite Teacher Assistant · ${new Date().toLocaleDateString('pt-BR')}
  </div>

  <script>
    // Abre o diálogo de impressão automaticamente
    window.addEventListener('load', () => {
      setTimeout(() => window.print(), 400);
    });
  </scr` + `ipt>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=850,height=1100');
  if (!win) {
    showError('O navegador bloqueou o popup. Permita popups para este site e tente novamente.');
    return;
  }
  win.document.write(html);
  win.document.close();
}

function resetProgressUI() {
  dom.progressSection.classList.add('hidden');
  dom.filePreview.classList.remove('hidden');
  dom.dropZone.classList.add('hidden');
  // Reseta steps
  [1, 2, 3].forEach(n => {
    const el = dom[`step${n}`];
    el.classList.remove('active', 'done');
    el.querySelector('.step-circle span').textContent = n;
    dom[`step${n}Desc`].textContent = 'Aguardando…';
  });
  setProgress(0, 'Inicializando…');
}

function resetAll() {
  clearFileSelection();
  dom.progressSection.classList.add('hidden');
  dom.resultsSection.classList.add('hidden');
  dom.transcriptionBox.textContent = '';
  const container = document.getElementById('studentsContainer');
  if (container) container.innerHTML = '';
  resetProgressUI();
}

// ─── Error Toast ──────────────────────────────────────────────────────────────

function showError(msg) {
  dom.errorMsg.textContent = msg;
  dom.errorToast.classList.remove('hidden');
  setTimeout(() => dom.errorToast.classList.add('hidden'), 8000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function blobToBase64(blob, mimeType) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      const resolvedMime = GEMINI_AUDIO_MIMES[mimeType] || mimeType;
      resolve({ base64, mimeType: resolvedMime });
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function isAudioFile(file) {
  if (AUDIO_MIME_TYPES.has(file.type)) return true;
  const ext = getExtension(file.name).toLowerCase();
  return ['.mp3','.wav','.ogg','.flac','.m4a','.aac','.opus'].includes(ext);
}

function getExtension(name) {
  const m = name.match(/\.[^.]+$/);
  return m ? m[0] : '';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Events ───────────────────────────────────────────────────────────────────

function attachEvents() {
  // ─ API Key card toggle
  dom.apiKeyToggle.addEventListener('click', () => {
    const collapsed = dom.apiKeyBody.classList.toggle('collapsed');
    dom.apiChevron.classList.toggle('open', !collapsed);
    dom.apiKeyToggle.setAttribute('aria-expanded', String(!collapsed));
  });

  // ─ Show/hide API key
  dom.toggleVis.addEventListener('click', () => {
    const isPass = dom.apiKeyInput.type === 'password';
    dom.apiKeyInput.type = isPass ? 'text' : 'password';
    dom.eyeIcon.innerHTML = isPass
      ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`
      : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>`;
  });

  dom.saveApiKey.addEventListener('click', saveApiKey);
  dom.clearApiKey.addEventListener('click', clearApiKey);

  dom.apiKeyInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveApiKey();
  });

  // ─ File input via click
  dom.dropZone.addEventListener('click', () => dom.fileInput.click());
  dom.dropZone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dom.fileInput.click(); }
  });

  dom.fileInput.addEventListener('change', e => {
    if (e.target.files[0]) handleFileSelected(e.target.files[0]);
  });

  // ─ Drag & Drop
  dom.dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dom.dropZone.classList.add('drag-over');
  });

  dom.dropZone.addEventListener('dragleave', () => {
    dom.dropZone.classList.remove('drag-over');
  });

  dom.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dom.dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelected(file);
  });

  dom.clearFile.addEventListener('click', clearFileSelection);

  // ─ Transcribe
  dom.transcribeBtn.addEventListener('click', startTranscription);

  dom.copyBtn.addEventListener('click', async () => {
    const text = dom.transcriptionBox.textContent;
    await navigator.clipboard.writeText(text);
    // Removemos ou atualizamos temporariamente o HTML do botão, mantendo o SVG
    const originalHTML = dom.copyBtn.innerHTML;
    dom.copyBtn.innerHTML = `✓ Copiado!`;
    setTimeout(() => {
      dom.copyBtn.innerHTML = originalHTML;
    }, 2000);
  });

  // O downloadBtn foi removido do HTML (agora temos o PDF), então tiramos o event listener dele
  // dom.downloadBtn.addEventListener(...)


  dom.resetBtn.addEventListener('click', resetAll);

  // ─ Error toast
  dom.closeToast.addEventListener('click', () => dom.errorToast.classList.add('hidden'));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
