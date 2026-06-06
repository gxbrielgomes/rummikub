# Rummikub Timer

Controle de partidas de Rummikub com timer por turno, placar e sincronização em tempo real entre dispositivos.

## Instalação local

```bash
pip install -r requirements.txt
```

## Rodar localmente

```bash
python app.py
```

Acesse: [http://localhost:5000](http://localhost:5000)

Para usar em outros dispositivos na mesma rede Wi-Fi, descubra o IP do computador:

```bash
# Windows
ipconfig
```

E acesse `http://SEU_IP:5000` no celular ou outro dispositivo.

## Deploy no Render

### 1. Suba o projeto para o GitHub

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/SEU_USUARIO/SEU_REPO.git
git push -u origin main
```

### 2. Configure o Web Service no Render

| Campo | Valor |
|---|---|
| **Build Command** | `pip install -r requirements.txt` |
| **Start Command** | `gunicorn --workers 1 --threads 4 --timeout 120 app:app` |
| **Environment** | Python 3 |

> O comando usa `--workers 1 --threads 4` para suportar as conexões SSE (tempo real) corretamente.

## Estrutura do projeto

```
rummikub_timer/
├── app.py              # Backend Flask
├── requirements.txt    # Dependências Python
├── static/
│   ├── script.js       # Lógica do front-end
│   └── style.css       # Estilos
└── templates/
    └── index.html      # Página principal
```
