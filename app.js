/**
 * AoneSite — app.js
 * Fluxo: File Upload → Base64 → Gemini API (suporta áudio E vídeo nativamente)
 * FFmpeg removido: desnecessário pois Gemini lê video/mp4, video/webm etc. diretamente.
 */

// ─── Constantes ───────────────────────────────────────────────────────────────

const GEMINI_MODEL      = 'gemini-2.5-flash';
const GEMINI_API_BASE   = 'https://generativelanguage.googleapis.com/v1beta';
const INLINE_SIZE_LIMIT = 19 * 1024 * 1024; // 19 MB

// MIME types aceitos pelo Gemini (áudio e vídeo)
const GEMINI_MIME_MAP = {
  // Áudio
  'audio/mpeg':      'audio/mp3',
  'audio/mp3':       'audio/mp3',
  'audio/wav':       'audio/wav',
  'audio/x-wav':     'audio/wav',
  'audio/ogg':       'audio/ogg',
  'audio/flac':      'audio/flac',
  'audio/m4a':       'audio/m4a',
  'audio/mp4':       'audio/mp4',
  'audio/aac':       'audio/aac',
  'audio/webm':      'audio/webm',
  // Vídeo (Gemini lê diretamente, sem precisar extrair áudio)
  'video/mp4':       'video/mp4',
  'video/mpeg':      'video/mpeg',
  'video/quicktime': 'video/mov',
  'video/webm':      'video/webm',
  'video/x-msvideo': 'video/avi',
  'video/3gpp':      'video/3gpp',
  'video/x-matroska':'video/mp4',  // mkv → fallback mp4 container
};

// ─── Estado Global ────────────────────────────────────────────────────────────

const state = {
  apiKey: null,
  file:   null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const dom = {
  // API Key
  apiKeyToggle:    $('apiKeyToggle'),
  apiKeyBody:      $('apiKeyBody'),
  apiChevron:      $('apiChevron'),
  apiKeyDot:       $('apiKeyDot'),
  apiKeyInput:     $('apiKeyInput'),
  toggleVis:       $('toggleVisibility'),
  eyeIcon:         $('eyeIcon'),
  saveApiKey:      $('saveApiKey'),
  clearApiKey:     $('clearApiKey'),
  keyFeedback:     $('keyFeedback'),
  // Upload
  dropZone:        $('dropZone'),
  fileInput:       $('fileInput'),
  filePreview:     $('filePreview'),
  fileTypeBadge:   $('fileTypeBadge'),
  fileName:        $('fileName'),
  fileSize:        $('fileSize'),
  clearFile:       $('clearFile'),
  cefrLevel:       $('cefrLevel'),
  classFocus:      $('classFocus'),
  transcribeBtn:   $('transcribeBtn'),
  // Progress
  progressSection: $('progressSection'),
  step1:           $('step1'),
  step1Desc:       $('step1Desc'),
  step2:           $('step2'),
  step2Desc:       $('step2Desc'),
  step3:           $('step3'),
  step3Desc:       $('step3Desc'),
  progressFill:    $('progressFill'),
  progressMsg:     $('progressMsg'),
  // Results
  resultsSection:  $('resultsSection'),
  transcriptionBox:$('transcriptionBox'),
  copyBtn:         $('copyBtn'),
  resetBtn:        $('resetBtn'),
  // Error
  errorToast:      $('errorToast'),
  errorMsg:        $('errorMsg'),
  closeToast:      $('closeToast'),
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

function init() {
  loadSavedApiKey();
  attachEvents();
}

// ─── API Key ──────────────────────────────────────────────────────────────────

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
  setTimeout(() => {
    dom.keyFeedback.textContent = '';
    dom.keyFeedback.className = 'key-feedback';
  }, 4000);
}

function collapseApiCard() {
  dom.apiKeyBody.classList.add('collapsed');
  dom.apiChevron.classList.remove('open');
  dom.apiKeyToggle.setAttribute('aria-expanded', 'false');
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

// ─── Pipeline de Transcrição ──────────────────────────────────────────────────

async function startTranscription() {
  if (!state.apiKey) {
    showError('Configure sua API Key do Gemini antes de transcrever.');
    return;
  }
  if (!state.file) {
    showError('Selecione um arquivo de áudio ou vídeo.');
    return;
  }

  const basePrompt = `Analise o áudio desta aula de inglês. Retorne estritamente um JSON com a seguinte estrutura:
1. "transcricao_diarizada": array de objetos com "speaker" e "text" para cada fala.
2. "alunos": um array de objetos. Para cada aluno, forneça:
  - "nome": string com o nome do aluno.
  - "pontos_fracos": array de strings indicando os erros cometidos. É OBRIGATÓRIO citar a frase exata dita pelo aluno ou o contexto do momento em que ocorreu o erro para justificar a correção.
  - "exercicios_recomendados": array de strings com sugestões de exercícios práticos criados ESPECIFICAMENTE para corrigir os erros exatos apontados no item anterior.`;
  
  const level = dom.cefrLevel ? dom.cefrLevel.value : 'B1';
  const focus = dom.classFocus ? dom.classFocus.value : 'Inglês Geral';
  const prompt = `[CONTEXTO PEDAGÓGICO]: Os alunos desta aula estão no nível CEFR ${level} e o foco principal desta aula foi "${focus}". Ajuste o rigor das correções e crie os exercícios recomendados focados estritamente neste nível e neste objetivo principal.\n\n${basePrompt}`;

  dom.filePreview.classList.add('hidden');
  dom.dropZone.classList.add('hidden');
  dom.progressSection.classList.remove('hidden');
  dom.resultsSection.classList.add('hidden');
  dom.transcribeBtn.disabled = true;

  try {
    // ── Passo 1: Ler arquivo ───────────────────────────────────────
    setStep(1, 'active');
    setProgress(15, 'Lendo arquivo…');
    dom.step1Desc.textContent = `${formatBytes(state.file.size)} carregado.`;
    setStep(1, 'done');

    // ── Passo 2: Codificar Base64 ──────────────────────────────────
    setStep(2, 'active');
    dom.step2Desc.textContent = 'Convertendo para Base64…';
    setProgress(40, 'Codificando arquivo…');

    const mimeType = resolveMime(state.file);
    const base64   = await readFileAsBase64(state.file);

    dom.step2Desc.textContent = 'Pronto para envio.';
    setProgress(60, 'Codificação concluída.');
    setStep(2, 'done');

    // ── Passo 3: Gemini API ────────────────────────────────────────
    setStep(3, 'active');
    dom.step3Desc.textContent = 'Enviando para Gemini AI…';
    setProgress(75, `Aguardando ${GEMINI_MODEL}…`);

    let result;
    if (state.file.size > INLINE_SIZE_LIMIT) {
      dom.step3Desc.textContent = 'Arquivo grande — usando File Upload API…';
      setProgress(78, 'Fazendo upload do arquivo…');
      const fileUri = await uploadFileToGemini(state.file, mimeType);
      result = await generateFromFileUri(fileUri, mimeType, prompt);
    } else {
      result = await generateInline(base64, mimeType, prompt);
    }

    dom.step3Desc.textContent = 'Análise recebida!';
    setProgress(100, 'Concluído.');
    setStep(3, 'done');

    setTimeout(() => showResults(result), 500);

  } catch (err) {
    console.error('[AoneSite]', err);
    showError(err.message || 'Erro desconhecido. Verifique o console.');
    resetProgressUI();
  } finally {
    dom.transcribeBtn.disabled = false;
  }
}

// ─── Gemini API ───────────────────────────────────────────────────────────────

async function generateInline(base64, mimeType, prompt) {
  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${state.apiKey}`;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64 } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseGeminiResponse(await res.json(), res.ok);
}

async function uploadFileToGemini(file, mimeType) {
  const startRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${state.apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(file.size),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'aonesite_upload' } }),
    }
  );
  if (!startRes.ok) throw new Error(`Erro ao iniciar upload: ${startRes.status}`);
  const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('URL de upload não recebida.');

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(file.size),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: file,
  });
  if (!uploadRes.ok) throw new Error(`Erro no upload: ${uploadRes.status}`);
  const data = await uploadRes.json();
  return data.file?.uri;
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
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
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
  } catch {
    throw new Error('Resposta do Gemini não é um JSON válido. Ajuste a instrução e tente novamente.');
  }
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function setStep(num, status) {
  const el = dom[`step${num}`];
  el.classList.remove('active', 'done');
  if (status) el.classList.add(status);
  if (status === 'done') el.querySelector('.step-circle span').textContent = '✓';
}

function setProgress(pct, msg) {
  dom.progressFill.style.width = `${pct}%`;
  if (msg) dom.progressMsg.textContent = msg;
}

function showResults(data) {
  dom.progressSection.classList.add('hidden');
  let transcriptionText = '';
  if (Array.isArray(data.transcricao_diarizada)) {
    transcriptionText = data.transcricao_diarizada.map(item => {
      if (typeof item === 'string') return item;
      const speaker = item.speaker || item.identificador || item.pessoa || 'Voz';
      const text = item.text || item.fala || item.conteudo || '';
      return `${speaker}: ${text}`;
    }).join('\n');
  } else {
    transcriptionText = data.transcricao_diarizada || 'Nenhuma transcrição retornada.';
  }
  dom.transcriptionBox.textContent = transcriptionText;

  const container = document.getElementById('studentsContainer');
  container.innerHTML = '';

  const alunos = data.alunos || [];
  if (alunos.length === 0) {
    container.innerHTML = '<p style="color:var(--text-dim);font-size:.85rem;">Nenhum aluno identificado.</p>';
  } else {
    alunos.forEach(aluno => {
      const card = document.createElement('div');
      card.className = 'student-card';

      card.innerHTML = `
        <h4>${aluno.nome}</h4>
        <strong>Pontos a Melhorar:</strong>
        <ul>${(aluno.pontos_fracos || []).map(p => `<li>${p}</li>`).join('')}</ul>
        <strong>Exercícios Recomendados:</strong>
        <ul>${(aluno.exercicios_recomendados || []).map(e => `<li>${e}</li>`).join('')}</ul>
      `;

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
  const pontosHTML     = (aluno.pontos_fracos || []).map(p => `<li>${p}</li>`).join('');
  const exerciciosHTML = (aluno.exercicios_recomendados || []).map(e => `<li>${e}</li>`).join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"/>
  <title>Feedback — ${aluno.nome}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',Arial,sans-serif;color:#1e293b;background:#fff;padding:48px 56px;max-width:780px;margin:0 auto}
    .header{text-align:center;border-bottom:3px solid #7c3aed;padding-bottom:24px;margin-bottom:36px}
    .logo-label{font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#7c3aed;margin-bottom:10px}
    h1{font-size:26px;font-weight:700;color:#1e293b;margin-bottom:6px}
    .student-name{font-size:15px;color:#64748b}
    .section{margin-bottom:32px}
    h2{font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:1px;padding:8px 14px;border-radius:6px;margin-bottom:14px}
    .section-red h2{color:#ef4444;background:#fef2f2;border-left:4px solid #ef4444}
    .section-green h2{color:#059669;background:#f0fdf4;border-left:4px solid #059669}
    ul{padding-left:20px;line-height:1.8;font-size:14px;color:#334155}
    ul li{margin-bottom:4px}
    .footer{margin-top:60px;padding-top:18px;border-top:1px solid #e2e8f0;text-align:center;font-size:10px;color:#94a3b8}
    @media print{body{padding:24px 32px}@page{margin:1cm}}
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
  <div class="footer">Generated by AoneSite Teacher Assistant · ${new Date().toLocaleDateString('pt-BR')}</div>
  <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400));<\/script>
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

function showError(msg) {
  dom.errorMsg.textContent = msg;
  dom.errorToast.classList.remove('hidden');
  setTimeout(() => dom.errorToast.classList.add('hidden'), 8000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveMime(file) {
  return GEMINI_MIME_MAP[file.type] || file.type || 'video/mp4';
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror  = reject;
    reader.readAsDataURL(file);
  });
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
  // API Key toggle
  dom.apiKeyToggle.addEventListener('click', () => {
    const collapsed = dom.apiKeyBody.classList.toggle('collapsed');
    dom.apiChevron.classList.toggle('open', !collapsed);
    dom.apiKeyToggle.setAttribute('aria-expanded', String(!collapsed));
  });

  // Show/hide key
  dom.toggleVis.addEventListener('click', () => {
    const isPass = dom.apiKeyInput.type === 'password';
    dom.apiKeyInput.type = isPass ? 'text' : 'password';
    dom.eyeIcon.innerHTML = isPass
      ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`
      : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>`;
  });

  dom.saveApiKey.addEventListener('click', saveApiKey);
  dom.clearApiKey.addEventListener('click', clearApiKey);
  dom.apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveApiKey(); });

  // File input
  dom.dropZone.addEventListener('click', () => dom.fileInput.click());
  dom.dropZone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dom.fileInput.click(); }
  });
  dom.fileInput.addEventListener('change', e => {
    if (e.target.files[0]) handleFileSelected(e.target.files[0]);
  });

  // Drag & Drop
  dom.dropZone.addEventListener('dragover', e => { e.preventDefault(); dom.dropZone.classList.add('drag-over'); });
  dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('drag-over'));
  dom.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dom.dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelected(file);
  });

  dom.clearFile.addEventListener('click', clearFileSelection);
  dom.transcribeBtn.addEventListener('click', startTranscription);

  // Copy transcription
  dom.copyBtn.addEventListener('click', async () => {
    const orig = dom.copyBtn.innerHTML;
    await navigator.clipboard.writeText(dom.transcriptionBox.textContent);
    dom.copyBtn.innerHTML = '✓ Copiado!';
    setTimeout(() => { dom.copyBtn.innerHTML = orig; }, 2000);
  });

  dom.resetBtn.addEventListener('click', resetAll);
  dom.closeToast.addEventListener('click', () => dom.errorToast.classList.add('hidden'));
}

// ─── Start ────────────────────────────────────────────────────────────────────

init();
