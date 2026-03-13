#!/bin/bash
# run-payment.sh <rail> <paymentId> [amount]
# Runs the payment script and POSTs result to callback — all in one command.

RAIL=$1
PAYMENT_ID=$2
AMOUNT=$3

case $RAIL in
  nanopayment)
    RESULT=$(cd /home/ec2-user/payclaw/shared/scripts && npx tsx nanopayment.ts --url "http://localhost:3100/api/service/premium" --chain "arcTestnet" 2>/dev/null)
    ;;
  agent_card)
    RESULT=$(cd /home/ec2-user/payclaw/shared/scripts && npx tsx agent-card-payment.ts --amount "$AMOUNT" --description "Railclaw payment" 2>/dev/null)
    ;;
  *)
    RESULT="{\"status\":\"error\",\"message\":\"unknown rail: $RAIL\"}"
    ;;
esac

printf '{"paymentId":"%s","result":%s}' "$PAYMENT_ID" "$RESULT" | \
  curl -s -X POST http://localhost:3100/api/payment-callback \
    -H "Content-Type: application/json" \
    --data @-
