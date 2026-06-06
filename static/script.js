/* ═══════════════════════════════════════════════════════════════
   script.js — Rummikub Timer
   Todas as telas são controladas aqui; o Flask serve apenas dados.
════════════════════════════════════════════════════════════════ */

// ── Constantes de cor ───────────────────────────────────────────
const COLOR_CLASS = ['c0', 'c1', 'c2', 'c3'];
const COLOR_HEX   = ['#e74c3c', '#3498db', '#e67e22', '#95a5a6'];
const MEDALS      = ['🥇', '🥈', '🥉', '4º'];

// ── Estado do timer ─────────────────────────────────────────────
let timerInterval      = null;
let timerStartEpochMs  = null;  // server turn_start_epoch * 1000
let timerDuration      = 0;     // segundos do turno atual
let timerIsPaused      = false;
let timerPausedElapsed = 0;     // segundos decorridos no momento do pause
let lastBeepSecond     = Infinity;
let currentTurnKey     = null;  // 'round-playerIdx' — detecta mesmo turno no SSE

// ── Estado do jogo (cache local do último retorno da API) ────────
let gameState         = null;
let playerCount       = 0;
let isPerformingAction = false; // bloqueia re-render do SSE durante ações ativas

// ── Áudio ────────────────────────────────────────────────────────
let audioCtx   = null;
let alarmAudio = null;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/** Aviso de 1 minuto: dois bipes ascendentes */
function playWarningBeep() {
  try {
    const ctx = getAudioCtx();
    [0, 0.28].forEach((delay, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 880 + i * 220;
      gain.gain.setValueAtTime(0.45, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.45);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.45);
    });
  } catch (_) {}
}

/** Tick de contagem regressiva (últimos 10 segundos) */
function playTickBeep() {
  try {
    const ctx  = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.value = 1100;
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.09);
  } catch (_) {}
}

/** Toca alarm.mp3 uma única vez (sem loop) */
function playAlarm() {
  if (alarmAudio) return;
  alarmAudio = new Audio('/static/alarm.mp3');
  alarmAudio.loop = false;
  alarmAudio.volume = 1.0;
  alarmAudio.play().catch(() => {});
  // Para automaticamente após 4 s para não parecer game-over
  setTimeout(stopAlarm, 4000);
}

function stopAlarm() {
  if (alarmAudio) {
    alarmAudio.pause();
    alarmAudio.currentTime = 0;
    alarmAudio = null;
  }
}

// ════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // Adiciona dois jogadores padrão na tela de setup
  addPlayer();
  addPlayer();

  // Se já houver um jogo em memória no servidor, retoma
  try {
    const res   = await fetch('/api/state');
    const state = await res.json();
    if (state.status && state.status !== 'no_game') {
      gameState = state;
      renderByState(state);
    }
  } catch (_) {
    // Servidor inacessível ou sem jogo — fica na tela de setup
  }

  // ── SSE: atualizações em tempo real de outros dispositivos ──────
  const evtSource = new EventSource('/api/events');
  evtSource.onmessage = async () => {
    if (isPerformingAction) return;
    try {
      const res   = await fetch('/api/state');
      const state = await res.json();
      if (!state.status || state.status === 'no_game') {
        resetLocalState();
        return;
      }
      gameState = state;
      renderByState(state);
    } catch (_) {}
  };
  // reconecta automaticamente em caso de queda
  evtSource.onerror = () => {};
});

// ════════════════════════════════════════════════════════════════
//  SETUP — adicionar / remover jogadores
// ════════════════════════════════════════════════════════════════
function addPlayer() {
  if (playerCount >= 4) return;

  const idx  = playerCount;
  playerCount++;

  const list = document.getElementById('players-list');
  const row  = document.createElement('div');
  row.className = 'player-row';
  row.id = `player-row-${idx}`;

  row.innerHTML = `
    <div class="player-row-header">
      <div class="player-label-row">
        <div class="color-dot ${COLOR_CLASS[idx]}"></div>
        Jogador ${idx + 1}
      </div>
      ${idx >= 2
        ? '<button class="btn-remove" onclick="removeLastPlayer()">Remover</button>'
        : ''}
    </div>
    <div class="player-fields">
      <div class="field-group field-name">
        <label>Nome</label>
        <input
          type="text"
          id="player-name-${idx}"
          placeholder="Nome do jogador"
          maxlength="20"
          autocomplete="off"
        />
      </div>
      <div class="field-group field-name">
        <label>Segundos extras</label>
        <input
          type="number"
          id="player-sec-${idx}"
          value="0"
          min="0"
          max="59"
        />
      </div>
    </div>
  `;

  list.appendChild(row);
  updateAddButton();
}

function removeLastPlayer() {
  if (playerCount <= 2) return;
  playerCount--;
  const row = document.getElementById(`player-row-${playerCount}`);
  if (row) row.remove();
  updateAddButton();
}

function updateAddButton() {
  const btn = document.getElementById('btn-add-player');
  if (btn) btn.style.display = playerCount >= 4 ? 'none' : '';
}

// ════════════════════════════════════════════════════════════════
//  INICIAR JOGO
// ════════════════════════════════════════════════════════════════
async function startGame() {
  hideError('setup-error');

  const players = [];

  const globalMinEl = document.getElementById('global-minutes');
  const globalMins  = globalMinEl ? (parseInt(globalMinEl.value, 10) || 0) : 2;

  for (let i = 0; i < playerCount; i++) {
    const nameEl = document.getElementById(`player-name-${i}`);
    const secEl  = document.getElementById(`player-sec-${i}`);

    const name  = nameEl ? nameEl.value.trim() : '';
    const secs  = secEl  ? (parseInt(secEl.value,  10) || 0) : 0;
    const total = globalMins * 60 + secs;

    if (!name) {
      showError('setup-error', `Jogador ${i + 1} precisa ter um nome.`);
      return;
    }
    if (total <= 0) {
      showError('setup-error', `"${name}": o tempo por jogada deve ser maior que zero.`);
      return;
    }

    players.push({ name, turn_time_seconds: total });
  }

  if (players.length < 2) {
    showError('setup-error', 'Adicione pelo menos 2 jogadores.');
    return;
  }

  try {
    const res   = await apiPost('/api/start', { players });
    const state = await res.json();

    if (!res.ok) {
      showError('setup-error', state.error || 'Erro ao iniciar jogo.');
      return;
    }

    gameState = state;
    renderByState(state);
  } catch (_) {
    showError('setup-error', 'Erro de conexão com o servidor.');
  }
}

// ════════════════════════════════════════════════════════════════
//  ROTEAMENTO — escolhe qual tela renderizar
// ════════════════════════════════════════════════════════════════
function renderByState(state) {
  if      (state.status === 'playing')   showTurnScreen(state);
  else if (state.status === 'round_end') showRoundEndScreen(state);
  else if (state.status === 'finished')  showFinalScreen(state);
}

// ════════════════════════════════════════════════════════════════
//  TELA DE TURNO
// ════════════════════════════════════════════════════════════════
function showTurnScreen(state) {
  showScreen('screen-turn');

  const player = state.current_player;
  const idx    = state.current_player_index;

  // Cabeçalho
  document.getElementById('turn-round').textContent = state.round;
  document.getElementById('turn-name').textContent  = player.name;

  // Cor do card
  const card = document.getElementById('current-card');
  card.className = `player-turn-card ${COLOR_CLASS[idx % 4]}`;

  // Lista de ordem dos jogadores
  const orderEl = document.getElementById('turn-order-list');
  orderEl.innerHTML = state.players.map((p, i) => `
    <div class="order-item ${i === idx ? 'current' : ''}">
      <div class="order-dot ${COLOR_CLASS[i % 4]}"></div>
      <span>${esc(p.name)}</span>
    </div>
  `).join('');

  // Mini placar
  renderMiniScoreboard(state.players);

  // Timer — sincronizado com o servidor para multi-dispositivo
  syncTimerFromState(state);
}

function renderMiniScoreboard(players) {
  const el = document.getElementById('mini-scoreboard');
  el.innerHTML = players.map((p, i) => `
    <div class="mini-score-item">
      <div class="color-dot ${COLOR_CLASS[i % 4]}"></div>
      <span class="mini-score-name">${esc(p.name)}</span>
      <span class="mini-score-wins">${p.wins} ${p.wins === 1 ? 'vitória' : 'vitórias'}</span>
    </div>
  `).join('');
}

// ════════════════════════════════════════════════════════════════
//  TIMER
// ════════════════════════════════════════════════════════════════

/**
 * Sincroniza o timer com o estado vindo do servidor.
 * Garante que todos os dispositivos mostrem o mesmo tempo.
 */
function syncTimerFromState(state) {
  const newKey     = `${state.round}-${state.current_player_index}`;
  const isSameTurn = newKey === currentTurnKey;

  // Para o intervalo sem matar o alarme se for o mesmo turno
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (!isSameTurn) {
    stopAlarm();
    lastBeepSecond = Infinity;
    currentTurnKey = newKey;
  }

  timerDuration      = state.current_player.turn_time_seconds;
  timerIsPaused      = state.is_paused;
  timerPausedElapsed = state.paused_elapsed || 0;

  if (state.is_paused) {
    timerStartEpochMs = null;
    const remaining = Math.max(0, timerDuration - timerPausedElapsed);
    renderTimerDisplay(remaining);
    stopAlarm();
    setTimerBox(remaining <= 0 ? 'danger' : (remaining <= 20 ? 'warning' : ''));
    setTimerStatus('⏸ Pausado', false);
    updatePauseButton(true);
  } else {
    // Usa elapsed_seconds do servidor para reconstruir o start local.
    // Isso elimina o clock skew entre dispositivos com relógios diferentes.
    timerStartEpochMs = Date.now() - (state.elapsed_seconds || 0) * 1000;
    updatePauseButton(false);
    timerInterval = setInterval(tickTimer, 250);
  }
}

function startTimer(durationSeconds) {
  stopTimer();
  timerDuration      = durationSeconds;
  timerStartEpochMs  = Date.now();
  timerIsPaused      = false;
  timerPausedElapsed = 0;
  lastBeepSecond     = Infinity;
  currentTurnKey     = null;

  setTimerBox('');
  setTimerStatus('Jogando...', false);
  renderTimerDisplay(durationSeconds);

  timerInterval = setInterval(tickTimer, 250);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  stopAlarm();
}

function tickTimer() {
  if (timerIsPaused || !timerStartEpochMs) return;
  const elapsed   = (Date.now() - timerStartEpochMs) / 1000;
  const remaining = timerDuration - elapsed;

  // ── Sons por segundo ──────────────────────────────────────────
  const displaySec = Math.max(0, Math.ceil(remaining));
  if (displaySec < lastBeepSecond) {
    lastBeepSecond = displaySec;
    if (displaySec === 60) {
      playWarningBeep();
    } else if (displaySec >= 1 && displaySec <= 10) {
      playTickBeep();
    }
  }

  if (remaining <= 0) {
    renderTimerDisplay(0);
    // Para de contar — tempo esgotado, aguarda o botão Próximo Jogador
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    const box = document.getElementById('timer-box');
    if (!box.classList.contains('danger')) {
      setTimerBox('danger');
      setTimerStatus('⏰ Tempo esgotado — passe o turno!', true);
      playAlarm();
    }
  } else if (remaining <= 20) {
    renderTimerDisplay(remaining);
    setTimerBox('warning');
    setTimerStatus('Atenção...', false);
  } else {
    renderTimerDisplay(remaining);
    setTimerBox('');
    setTimerStatus('Jogando...', false);
  }
}

function renderTimerDisplay(seconds) {
  const s    = Math.max(0, Math.ceil(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  document.getElementById('timer-text').textContent =
    pad2(mins) + ':' + pad2(secs);
}

function setTimerBox(cls) {
  document.getElementById('timer-box').className = 'timer-box' + (cls ? ' ' + cls : '');
}

function setTimerStatus(text, isTimeout) {
  const el = document.getElementById('timer-status');
  el.textContent = text;
  el.className   = 'timer-status' + (isTimeout ? ' timeout' : '');
}

/** Retorna o tempo decorrido desde o início do turno, em segundos. */
function getTimeUsed() {
  if (timerIsPaused) return Math.round(timerPausedElapsed);
  if (!timerStartEpochMs) return 0;
  return Math.round((Date.now() - timerStartEpochMs) / 1000);
}

// ════════════════════════════════════════════════════════════════
//  PRÓXIMO JOGADOR
// ════════════════════════════════════════════════════════════════
async function nextTurn() {
  isPerformingAction = true;
  const timeUsed = getTimeUsed();
  stopTimer();

  try {
    const res   = await apiPost('/api/next-turn', { time_used: timeUsed });
    const state = await res.json();

    if (!res.ok) {
      isPerformingAction = false;
      alert(state.error || 'Erro ao passar turno.');
      // Retoma o timer do jogador atual se houver erro
      if (gameState && gameState.current_player) {
        startTimer(gameState.current_player.turn_time_seconds);
      }
      return;
    }

    gameState = state;
    showTurnScreen(state);
  } catch (_) {
    alert('Erro de conexão com o servidor.');
  } finally {
    isPerformingAction = false;
  }
}

// ════════════════════════════════════════════════════════════════
//  MODAL — CONFIRMAR VITÓRIA
// ════════════════════════════════════════════════════════════════
function showWinModal() {
  if (!gameState || gameState.status !== 'playing') return;
  const player = gameState.current_player;
  // Usa textContent para evitar injeção de HTML
  document.getElementById('win-modal-text').textContent =
    `Tem certeza que ${player.name} bateu?`;
  document.getElementById('win-modal').classList.remove('hidden');
  // O timer continua rodando — getTimeUsed() captura o tempo real inclusive durante o modal
}

function closeWinModal() {
  document.getElementById('win-modal').classList.add('hidden');
}

/** Fecha o modal se clicar fora da caixa */
function handleModalOverlayClick(event) {
  if (event.target === document.getElementById('win-modal')) {
    closeWinModal();
  }
}

async function confirmWin() {
  closeWinModal();
  isPerformingAction = true;
  const timeUsed = getTimeUsed();
  stopTimer();

  try {
    const res   = await apiPost('/api/win', { time_used: timeUsed });
    const state = await res.json();

    if (!res.ok) {
      alert(state.error || 'Erro ao registrar vitória.');
      return;
    }

    gameState = state;
    showRoundEndScreen(state);
  } catch (_) {
    alert('Erro de conexão com o servidor.');
  } finally {
    isPerformingAction = false;
  }
}

// ════════════════════════════════════════════════════════════════
//  TELA DE FIM DE RODADA
// ════════════════════════════════════════════════════════════════
function showRoundEndScreen(state) {
  stopTimer();
  showScreen('screen-round-end');

  const winner = state.last_winner;
  document.getElementById('round-winner-name').textContent =
    winner ? winner.name : '—';
  document.getElementById('round-end-number').textContent = state.round;

  const list = document.getElementById('round-end-scoreboard');
  list.innerHTML = state.players.map((p, i) => {
    const isWinner = winner && p.id === winner.id;
    return `
      <div class="score-card ${isWinner ? 'winner-card' : ''}">
        <div class="color-dot ${COLOR_CLASS[i % 4]}"></div>
        <div class="score-player-name">${esc(p.name)}</div>
        <div class="score-badges">
          <span class="badge gold">${p.wins} ${p.wins === 1 ? 'vitória' : 'vitórias'}</span>
          <span class="badge">${p.turns} turnos</span>
          <span class="badge">Média ${fmtTime(p.avg_time)}</span>
          <span class="badge">Total ${fmtTime(p.total_time)}</span>
        </div>
      </div>
    `;
  }).join('');
}

// ════════════════════════════════════════════════════════════════
//  NOVA RODADA
// ════════════════════════════════════════════════════════════════
async function newRound() {
  isPerformingAction = true;
  try {
    const res   = await apiPost('/api/new-round', {});
    const state = await res.json();

    if (!res.ok) {
      alert(state.error || 'Erro ao iniciar nova rodada.');
      return;
    }

    gameState = state;
    showTurnScreen(state);
  } catch (_) {
    alert('Erro de conexão com o servidor.');
  } finally {
    isPerformingAction = false;
  }
}

// ════════════════════════════════════════════════════════════════
//  FINALIZAR JOGO
// ════════════════════════════════════════════════════════════════
async function finishGame() {
  isPerformingAction = true;
  try {
    const res   = await apiPost('/api/finish', {});
    const state = await res.json();

    if (!res.ok) {
      alert(state.error || 'Erro ao finalizar jogo.');
      return;
    }

    gameState = state;
    showFinalScreen(state);
  } catch (_) {
    alert('Erro de conexão com o servidor.');
  } finally {
    isPerformingAction = false;
  }
}

// ════════════════════════════════════════════════════════════════
//  TELA FINAL
// ════════════════════════════════════════════════════════════════
function showFinalScreen(state) {
  stopTimer();
  showScreen('screen-final');

  const ranking  = state.ranking || [];
  const champion = ranking[0];

  document.getElementById('final-champion').textContent =
    champion ? champion.name : '—';

  // Ranking
  const rankEl = document.getElementById('final-ranking');
  rankEl.innerHTML = ranking.map((p, i) => `
    <div class="ranking-item ${i === 0 ? 'rank-first' : ''}">
      <div class="rank-pos">${MEDALS[i] || (i + 1) + 'º'}</div>
      <div class="color-dot" style="background:${COLOR_HEX[p.original_order % 4]}"></div>
      <div class="rank-name">${esc(p.name)}</div>
      <div class="rank-stats">
        <span class="rank-stat">${p.wins} ${p.wins === 1 ? 'vitória' : 'vitórias'}</span>
        <span class="rank-stat">Média ${fmtTime(p.avg_time)}</span>
        <span class="rank-stat">Total ${fmtTime(p.total_time)}</span>
      </div>
    </div>
  `).join('');

  // Resumo geral
  const fastestPlayer = ranking.reduce((best, p) => {
    if (p.turns === 0) return best;
    if (!best || p.avg_time < best.avg_time) return p;
    return best;
  }, null);

  const mostTimePlayer = ranking.reduce((most, p) => {
    if (!most || p.total_time > most.total_time) return p;
    return most;
  }, null);

  const sumEl = document.getElementById('final-summary');
  sumEl.innerHTML = `
    <div class="summary-item">
      <div class="summary-label">Rodadas jogadas</div>
      <div class="summary-value">${state.round}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Jogadores</div>
      <div class="summary-value">${ranking.length}</div>
    </div>
    ${fastestPlayer ? `
    <div class="summary-item">
      <div class="summary-label">Mais rápido (média)</div>
      <div class="summary-value">${esc(fastestPlayer.name)}</div>
    </div>` : ''}
    ${mostTimePlayer ? `
    <div class="summary-item">
      <div class="summary-label">Maior tempo total</div>
      <div class="summary-value">${esc(mostTimePlayer.name)}</div>
    </div>` : ''}
  `;
}

// ════════════════════════════════════════════════════════════════
//  NOVO JOGO (volta à tela de setup)
// ════════════════════════════════════════════════════════════════
function resetGame() {
  gameState         = null;
  timerStartEpochMs = null;
  timerIsPaused     = false;
  currentTurnKey    = null;
  stopTimer();

  // Limpa a lista de jogadores e recria com 2 slots
  document.getElementById('players-list').innerHTML = '';
  playerCount = 0;
  addPlayer();
  addPlayer();

  showScreen('screen-setup');
}

// ════════════════════════════════════════════════════════════════
//  PAUSE / RESUME
// ════════════════════════════════════════════════════════════════
async function pauseResumeTimer() {
  if (!gameState || gameState.status !== 'playing') return;
  const endpoint = timerIsPaused ? '/api/resume' : '/api/pause';
  try {
    const res   = await apiPost(endpoint, {});
    const state = await res.json();
    if (res.ok) {
      gameState = state;
      syncTimerFromState(state);
    }
  } catch (_) {}
}

function updatePauseButton(isPaused) {
  const btn = document.getElementById('btn-pause');
  if (!btn) return;
  btn.textContent = isPaused ? '▶ Continuar' : '⏸ Pausar';
  btn.className = 'btn btn-block ' + (isPaused ? 'btn-success' : 'btn-ghost');
}

// ════════════════════════════════════════════════════════════════
//  RESET LOCAL (quando outro dispositivo limpa o jogo via SSE)
// ════════════════════════════════════════════════════════════════
function resetLocalState() {
  gameState         = null;
  timerStartEpochMs = null;
  timerIsPaused     = false;
  currentTurnKey    = null;
  stopTimer();
  document.getElementById('players-list').innerHTML = '';
  playerCount = 0;
  addPlayer();
  addPlayer();
  showScreen('screen-setup');
}

// ════════════════════════════════════════════════════════════════
//  UTILITÁRIOS
// ════════════════════════════════════════════════════════════════

/** Exibe uma tela e oculta as demais; faz scroll ao topo. */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  window.scrollTo(0, 0);
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

/** Formata segundos como "2m 15s", "45s" etc. */
function fmtTime(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const s   = Math.round(seconds);
  const m   = Math.floor(s / 60);
  const rem = s % 60;
  if (m > 0 && rem > 0) return `${m}m ${rem}s`;
  if (m > 0)             return `${m}m`;
  return `${rem}s`;
}

/** Zero-padding para 2 dígitos. */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Escapa HTML para uso em innerHTML. */
function esc(text) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(text)));
  return div.innerHTML;
}

/** Wrapper para fetch POST com JSON. */
function apiPost(url, body) {
  return fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

// ════════════════════════════════════════════════════════════════
//  RESET TOTAL — limpar tudo e voltar do zero
// ════════════════════════════════════════════════════════════════
function openResetModal() {
  document.getElementById('reset-modal').classList.remove('hidden');
}

function closeResetModal() {
  document.getElementById('reset-modal').classList.add('hidden');
}

async function confirmClearAll() {
  closeResetModal();
  try {
    await fetch('/api/reset', { method: 'POST' });
  } catch (_) {}
  // Para garantir que tudo volta ao estado inicial, recarrega a página
  window.location.reload();
}
