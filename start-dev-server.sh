#!/bin/bash

# Definir variáveis de ambiente
export NODE_ENV=development

# Definir porta fixa para o DeepResearch Jina
SELECTED_PORT=3002

# Verificar se a porta está disponível
if lsof -i:$SELECTED_PORT > /dev/null 2>&1; then
  echo "Aviso: Porta $SELECTED_PORT está em uso."
  echo "Tentando encerrar processo anterior na porta $SELECTED_PORT..."
  PID=$(lsof -i:$SELECTED_PORT -t)
  if [ ! -z "$PID" ]; then
    kill -9 $PID
    echo "Processo anterior na porta $SELECTED_PORT encerrado."
  fi
else
  echo "Porta $SELECTED_PORT está disponível."
fi

# Iniciar o servidor
echo "Iniciando servidor Node DeepResearch Nexcode..."
echo "Porta: $SELECTED_PORT"
echo "NODE_ENV: $NODE_ENV"
echo "-------------------------------------------"

export PORT=$SELECTED_PORT
pnpm run start
