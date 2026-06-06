from flask import Flask, render_template, request, jsonify, Response
import time, queue, threading

app = Flask(__name__)

# Instância global do jogo — apenas um jogo por vez em memória
game_state = None

# ─── SSE — broadcast para todos os clientes conectados ───────────────────────
_subscribers = []
_sub_lock    = threading.Lock()

def _notify_all():
    with _sub_lock:
        dead = []
        for q in _subscribers:
            try:
                q.put_nowait('update')
            except Exception:
                dead.append(q)
        for q in dead:
            _subscribers.remove(q)


class Player:
    def __init__(self, player_id, name, turn_time_seconds, original_order):
        self.id = player_id
        self.name = name
        self.turn_time_seconds = turn_time_seconds
        self.wins = 0
        self.turn_times = []  # lista de segundos usados por turno
        self.original_order = original_order

    def to_dict(self):
        total_time = sum(self.turn_times)
        turns = len(self.turn_times)
        avg_time = total_time / turns if turns > 0 else 0
        return {
            'id': self.id,
            'name': self.name,
            'turn_time_seconds': self.turn_time_seconds,
            'wins': self.wins,
            'turns': turns,
            'total_time': round(total_time, 1),
            'avg_time': round(avg_time, 1),
            'original_order': self.original_order,
        }


class Game:
    def __init__(self, players_data):
        self.players = []
        for i, p in enumerate(players_data):
            self.players.append(Player(
                player_id=i,
                name=p['name'],
                turn_time_seconds=p['turn_time_seconds'],
                original_order=i,
            ))
        self.current_player_index = 0
        self.round = 1
        self.status = 'playing'  # playing | round_end | finished
        self.last_winner_id = None
        self.last_winner_index = None
        # Timer sync
        self.turn_start_epoch = time.time()
        self.is_paused        = False
        self.paused_elapsed   = 0.0

    def current_player(self):
        return self.players[self.current_player_index]

    def next_turn(self, time_used):
        self.current_player().turn_times.append(max(0, time_used))
        self.current_player_index = (self.current_player_index + 1) % len(self.players)
        self.turn_start_epoch = time.time()
        self.is_paused        = False
        self.paused_elapsed   = 0.0
        return self.to_dict()

    def register_win(self, time_used):
        player = self.current_player()
        player.turn_times.append(max(0, time_used))
        player.wins += 1
        self.last_winner_id = player.id
        self.last_winner_index = self.current_player_index
        self.status = 'round_end'
        return self.to_dict()

    def new_round(self):
        # Próxima rodada começa pelo jogador seguinte ao último vencedor
        if self.last_winner_index is not None:
            self.current_player_index = (self.last_winner_index + 1) % len(self.players)
        else:
            self.current_player_index = 0
        self.round += 1
        self.status = 'playing'
        self.last_winner_id = None
        self.last_winner_index = None
        self.turn_start_epoch = time.time()
        self.is_paused        = False
        self.paused_elapsed   = 0.0
        return self.to_dict()

    def pause(self):
        if self.is_paused or self.status != 'playing':
            return self.to_dict()
        self.paused_elapsed = time.time() - self.turn_start_epoch
        self.is_paused = True
        return self.to_dict()

    def resume(self):
        if not self.is_paused or self.status != 'playing':
            return self.to_dict()
        # Ajusta epoch para que o tempo continue de onde parou
        self.turn_start_epoch = time.time() - self.paused_elapsed
        self.is_paused = False
        return self.to_dict()

    def finish_game(self):
        self.status = 'finished'
        return self.to_dict()

    def get_ranking(self):
        """Ordena por: 1) mais vitórias, 2) menor tempo médio, 3) ordem original."""
        def sort_key(p):
            avg = (sum(p.turn_times) / len(p.turn_times)) if p.turn_times else float('inf')
            return (-p.wins, avg, p.original_order)
        return [p.to_dict() for p in sorted(self.players, key=sort_key)]

    def to_dict(self):
        cur = self.current_player() if self.status == 'playing' else None
        last_winner = next(
            (p for p in self.players if p.id == self.last_winner_id), None
        ) if self.last_winner_id is not None else None

        result = {
            'status': self.status,
            'round': self.round,
            'current_player': cur.to_dict() if cur else None,
            'current_player_index': self.current_player_index if self.status == 'playing' else None,
            'players': [p.to_dict() for p in self.players],
            'last_winner': last_winner.to_dict() if last_winner else None,
            'is_paused':        self.is_paused,
            'paused_elapsed':   round(self.paused_elapsed, 3),
            # elapsed_seconds: quantos segundos já passaram neste turno.
            # O cliente usa Date.now() - elapsed_seconds para montar o timer
            # sem depender do relógio absoluto do servidor (evita clock skew).
            'elapsed_seconds': round(
                self.paused_elapsed if self.is_paused
                else (time.time() - self.turn_start_epoch if self.status == 'playing' else 0),
                3
            ),
        }
        if self.status == 'finished':
            result['ranking'] = self.get_ranking()
        return result


# ─── Rotas ───────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/state', methods=['GET'])
def get_state():
    if game_state is None:
        return jsonify({'status': 'no_game'})
    return jsonify(game_state.to_dict())


@app.route('/api/start', methods=['POST'])
def start_game():
    global game_state
    data = request.get_json(silent=True)
    if not data or 'players' not in data:
        return jsonify({'error': 'Dados inválidos.'}), 400

    players = data['players']
    if len(players) < 2:
        return jsonify({'error': 'Mínimo de 2 jogadores.'}), 400
    if len(players) > 4:
        return jsonify({'error': 'Máximo de 4 jogadores.'}), 400

    for p in players:
        if not str(p.get('name', '')).strip():
            return jsonify({'error': 'Todos os jogadores precisam ter um nome.'}), 400
        try:
            secs = int(p['turn_time_seconds'])
        except (KeyError, TypeError, ValueError):
            return jsonify({'error': f'Tempo inválido para o jogador "{p.get("name", "")}"'}), 400
        if secs <= 0:
            return jsonify({'error': f'O tempo de "{p.get("name", "")}" deve ser maior que zero.'}), 400

    game_state = Game(players)
    _notify_all()
    return jsonify(game_state.to_dict())


@app.route('/api/next-turn', methods=['POST'])
def next_turn():
    global game_state
    if game_state is None or game_state.status != 'playing':
        return jsonify({'error': 'Nenhum jogo em andamento.'}), 400
    data = request.get_json(silent=True) or {}
    time_used = float(data.get('time_used', 0))
    result = game_state.next_turn(time_used)
    _notify_all()
    return jsonify(result)


@app.route('/api/win', methods=['POST'])
def register_win():
    global game_state
    if game_state is None or game_state.status != 'playing':
        return jsonify({'error': 'Nenhum jogo em andamento.'}), 400
    data = request.get_json(silent=True) or {}
    time_used = float(data.get('time_used', 0))
    result = game_state.register_win(time_used)
    _notify_all()
    return jsonify(result)


@app.route('/api/new-round', methods=['POST'])
def new_round():
    global game_state
    if game_state is None or game_state.status != 'round_end':
        return jsonify({'error': 'Nenhuma rodada encerrada para reiniciar.'}), 400
    result = game_state.new_round()
    _notify_all()
    return jsonify(result)


@app.route('/api/finish', methods=['POST'])
def finish_game():
    global game_state
    if game_state is None:
        return jsonify({'error': 'Nenhum jogo em andamento.'}), 400
    result = game_state.finish_game()
    _notify_all()
    return jsonify(result)


@app.route('/api/reset', methods=['POST'])
def reset_game():
    global game_state
    game_state = None
    _notify_all()
    return jsonify({'status': 'ok'})


@app.route('/api/pause', methods=['POST'])
def pause_timer():
    global game_state
    if game_state is None or game_state.status != 'playing':
        return jsonify({'error': 'Nenhum jogo em andamento.'}), 400
    result = game_state.pause()
    _notify_all()
    return jsonify(result)


@app.route('/api/resume', methods=['POST'])
def resume_timer():
    global game_state
    if game_state is None or game_state.status != 'playing':
        return jsonify({'error': 'Nenhum jogo em andamento.'}), 400
    result = game_state.resume()
    _notify_all()
    return jsonify(result)


@app.route('/api/events')
def sse_events():
    """Server-Sent Events — push de atualização para todos os clientes."""
    def stream():
        q = queue.Queue()
        with _sub_lock:
            _subscribers.append(q)
        try:
            yield 'data: connected\n\n'
            while True:
                try:
                    q.get(timeout=25)
                    yield 'data: update\n\n'
                except queue.Empty:
                    yield ': heartbeat\n\n'  # keep-alive
        finally:
            with _sub_lock:
                try:
                    _subscribers.remove(q)
                except ValueError:
                    pass
    return Response(
        stream(),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True, threaded=True)
