#!/bin/bash

# Definir variáveis de ambiente
export NODE_ENV=development

# Verificar portas em uso
echo "Verificando portas disponíveis para node-jina..."
PORTS=(3001)
SELECTED_PORT=""

for PORT in "${PORTS[@]}"; do
  if ! lsof -i:$PORT > /dev/null 2>&1; then
    SELECTED_PORT=$PORT
    echo "Porta $PORT está disponível."
    break
  else
    echo "Porta $PORT está em uso."
  fi
done

if [ -z "$SELECTED_PORT" ]; then
  echo "Todas as portas estão em uso. Usando porta 3199."
  SELECTED_PORT=3199
fi

# Iniciar o servidor
echo "Iniciando servidor Node DeepResearch Jina..."
echo "Porta: $SELECTED_PORT"
echo "NODE_ENV: $NODE_ENV"
echo "-------------------------------------------"

export PORT=$SELECTED_PORT
pnpm run start
