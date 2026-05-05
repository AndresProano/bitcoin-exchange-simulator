---
marp: true
theme: default
size: 16:9
paginate: true
header: 'Simulated Bitcoin Exchange · CMP-5001-202520'
footer: 'USFQ · Aplicaciones Distribuidas · Final Project'
style: |
  section {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 26px;
    padding: 50px 60px;
  }
  h1 { color: #1a4d8f; font-size: 46px; margin-bottom: 0.2em; }
  h2 { color: #1a4d8f; font-size: 34px; }
  h3 { color: #2b6cb0; }
  .lead { font-size: 22px; color: #444; }
  .key {
    background: #eaf3ff;
    border-left: 6px solid #1a4d8f;
    padding: 12px 18px;
    margin-top: 18px;
    font-size: 22px;
  }
  .row { display: flex; gap: 18px; align-items: stretch; }
  .col { flex: 1; }
  .box {
    border: 2px solid #1a4d8f;
    border-radius: 10px;
    padding: 14px 16px;
    background: #f7faff;
    font-size: 20px;
  }
  .box.alt { background: #fff8e6; border-color: #b8860b; }
  .box.green { background: #e8f6ec; border-color: #2e7d32; }
  .box.gray { background: #f0f0f0; border-color: #555; }
  .arrow { text-align: center; font-size: 28px; color: #1a4d8f; margin: 6px 0; font-weight: bold; }
  .arrow-h { text-align: center; font-size: 28px; color: #1a4d8f; align-self: center; padding: 0 4px; }
  .pill {
    display: inline-block; background: #1a4d8f; color: white;
    border-radius: 20px; padding: 4px 14px; font-size: 18px; margin: 2px;
  }
  table { font-size: 18px; }
  th { background: #1a4d8f; color: white; }
  code { background: #f4f4f4; padding: 1px 5px; border-radius: 3px; }
---

<!-- _paginate: false -->
<!-- _header: '' -->
<!-- _footer: '' -->

# Simulated Bitcoin Exchange
### Final Project · Phase 3

<br>

**Andrés Proaño · Pablo Alvarado**

CMP-5001-202520 · Aplicaciones Distribuidas
Universidad San Francisco de Quito
Semestre 202520

<br>

<div class="key">
<b>Objetivo:</b> simular un exchange de Bitcoin con minería on-chain, trading interno entre clientes y un historial auditable por cuenta.
</div>

---

## 1. Conceptos base

<div class="row">
<div class="col">

**Blockchain**
Cadena distribuida de bloques. Estado compartido entre nodos.

**Node**
Bitcoin Core ejecutando regtest, valida y propaga bloques/tx.

**Wallet**
Conjunto de claves y direcciones controladas por un actor.

</div>
<div class="col">

**Miner**
Resuelve PoW para anexar bloques y reclama el coinbase.

**Proof of Work**
Reto criptográfico que asegura el orden de la cadena.

**Coinbase maturity**
El BTC del coinbase queda bloqueado **100 bloques** antes de poder gastarse.

</div>
</div>

<div class="key">
El BTC <b>nace en blockchain mediante minería</b> y debe madurar antes de poder gastarse o transferirse.
</div>

---

## 2. Dos mundos del sistema

<div class="row">

<div class="col box">
<b>Blockchain system</b>
<ul>
<li>2 nodos Bitcoin Core (regtest)</li>
<li>10 mineros Python competitivos</li>
<li>Wallets controladas por mineros</li>
<li>Bloques, txs y maduración reales</li>
</ul>
</div>

<div class="arrow-h">⇄</div>

<div class="col box alt">
<b>Exchange system</b>
<ul>
<li>SQLite: cuentas internas</li>
<li>30 clientes con $30,000 USD</li>
<li>Owner account para fees</li>
<li>Trading interno (BTC ↔ USD)</li>
</ul>
</div>

</div>

<div class="arrow">⬆ frontera ⬆</div>

<div class="box green">
<b>BTC entra al exchange</b> únicamente cuando un miner emite una transacción on-chain hacia el <i>exchange deposit address</i> y el backend verifica la recepción.
</div>

<div class="key">
BTC en una wallet minera <b>no</b> es BTC dentro del exchange.
</div>

---

## 3. Arquitectura

<div class="row">
<div class="col box" style="text-align:center">
<b>React</b><br>
frontend :3000<br>
<small>UI · WebSocket</small>
</div>
<div class="arrow-h">→</div>
<div class="col box" style="text-align:center">
<b>Node.js / Express</b><br>
backend :3001<br>
<small>REST · Socket.IO</small>
</div>
<div class="arrow-h">→</div>
<div class="col box gray" style="text-align:center">
<b>SQLite</b><br>
exchange.db<br>
<small>accounts · orders · trades · history</small>
</div>
</div>

<div class="arrow">⇣ Bitcoin RPC ⇣</div>

<div class="row">
<div class="col box alt" style="text-align:center">
<b>node1</b><br>
bitcoin/bitcoin:29.3<br>
regtest
</div>
<div class="arrow-h">⇄</div>
<div class="col box alt" style="text-align:center">
<b>node2</b><br>
bitcoin/bitcoin:29.3<br>
regtest
</div>
<div class="arrow-h">←</div>
<div class="col box green" style="text-align:center">
<b>10 miners</b><br>
Python · regtest RPC<br>
<small>miner-1 ... miner-10</small>
</div>
</div>

<div class="key">
Cada servicio es un contenedor Docker. <b>Docker Compose</b> orquesta los 14 servicios.
Imágenes publicadas multi-arch: <code>byandyx/btc-{backend,frontend,miner}:proyecto-final</code>
</div>

---

## 4. Fase 1 · Mining & exchange entry

<div class="row">

<div class="col box">
<b>1. Mine</b>
miner-X corre PoW en regtest y anexa un bloque
</div>
<div class="arrow-h">→</div>
<div class="col box">
<b>2. Mature</b>
Coinbase espera 100 bloques de confirmación
</div>
<div class="arrow-h">→</div>
<div class="col box">
<b>3. Threshold</b>
Si <code>btc_mature ≥ threshold</code>, dispara depósito
</div>

</div>

<div class="arrow">↓</div>

<div class="row">

<div class="col box alt">
<b>4. On-chain tx</b>
miner llama <code>sendtoaddress</code> al deposit address del exchange
</div>
<div class="arrow-h">→</div>
<div class="col box alt">
<b>5. Backend verifica</b>
<code>POST /api/exchange/deposit</code> + <code>gettransaction</code> en node1
</div>
<div class="arrow-h">→</div>
<div class="col box green">
<b>6. Cuenta creada</b>
Aparece <code>miner-X</code> en exchange con BTC available
</div>

</div>

<div class="key">
Fase 1 explica <b>cómo el BTC entra al sistema del exchange</b>: minería real, maduración respetada y verificación on-chain antes de acreditar saldo interno.
</div>

---

## 5. Fase 2 · Trading interno

<div class="row">
<div class="col box">
<b>client_1</b>
Place <span class="pill">BUY 0.5 BTC @ $50k</span>
Reserva $25,000 USD
</div>

<div class="col box gray" style="text-align:center">
<b>Matching engine</b>
price-time priority
full match / no match
</div>

<div class="col box alt">
<b>miner-5</b>
Place <span class="pill">SELL 0.5 BTC @ $50k</span>
Reserva 0.5 BTC
</div>
</div>

<div class="arrow">↓ trade ejecutado ↓</div>

<div class="row">
<div class="col box green">
<b>Buyer recibe</b>
0.49 BTC (neto)
$25,000 debitado
</div>
<div class="col box green">
<b>Seller recibe</b>
$25,000 USD
0.5 BTC debitado
</div>
<div class="col box alt">
<b>Owner fee 2%</b>
0.01 BTC acreditado
sobre el bruto del trade
</div>
</div>

<div class="key">
Fase 2 convierte el sistema en un <b>mercado interno BTC ↔ USD</b> con reservas, prioridad price-time, matching atómico y fee del owner del 2 %.
</div>

---

## 6. Fase 3 · Historial por cliente

Cada cuenta acumula sus eventos BTC en la tabla `client_btc_history`:

<table>
<tr><th>Account ID</th><th>Client Name</th><th>Timestamp</th><th>Event Type</th><th>Event Details</th></tr>
<tr><td>client_1</td><td>Client 1</td><td>2026-05-04 16:56</td><td><b>Buy BTC</b></td><td>Received 0.49 BTC at $50,000 per BTC</td></tr>
<tr><td>miner-5</td><td>Miner 5</td><td>2026-05-04 16:56</td><td><b>Sell BTC</b></td><td>Sold 0.50 BTC at $50,000 per BTC</td></tr>
<tr><td>client_1</td><td>Client 1</td><td>2026-05-04 16:58</td><td><b>Transfer BTC</b></td><td>Transferred 0.10 BTC to bcrt1q4d… (txid f545…dcb9)</td></tr>
</table>

<div class="row" style="margin-top:14px">
<div class="col box">
<b>Buy BTC</b>
Cantidad + precio por BTC. Insertado al matchear orden compradora.
</div>
<div class="col box">
<b>Sell BTC</b>
Cantidad + precio por BTC. Insertado al matchear orden vendedora.
</div>
<div class="col box">
<b>Transfer BTC</b>
Cantidad retirada del exchange + dirección destino + txid on-chain.
</div>
</div>

<div class="key">
Fase 3 agrega <b>trazabilidad completa</b>: el orden cronológico permite explicar y auditar cada movimiento BTC de cualquier cuenta.
</div>

---

## 7. BTC Out · Retiro on-chain

<div class="row">
<div class="col box">
<b>UI</b>
Selecciona cuenta + address + monto
</div>
<div class="arrow-h">→</div>
<div class="col box">
<b>Backend</b>
<code>POST /api/clients/:id/transfer-btc</code>
Valida fondos + address regtest
</div>
<div class="arrow-h">→</div>
<div class="col box alt">
<b>Bitcoin RPC</b>
<code>sendtoaddress</code> desde wallet exchange
</div>
</div>

<div class="arrow">↓</div>

<div class="row">
<div class="col box green">
<b>Exchange DB</b>
Debita <code>btc_available</code>
Inserta evento <code>TRANSFER_BTC</code> con txid + address
</div>
<div class="arrow-h">→</div>
<div class="col box green">
<b>Blockchain</b>
Tx confirmable con
<code>gettransaction &lt;txid&gt;</code>
</div>
<div class="arrow-h">→</div>
<div class="col box">
<b>UI</b>
Refresh vía WebSocket <code>history-updated</code>
</div>
</div>

<div class="key">
BTC Out <b>saca BTC del exchange</b> mediante una transacción real en Bitcoin Core y deja un evento <code>Transfer BTC</code> auditable con su txid.
</div>

---

## 8. Demo · ciclo completo

1. **Servicios up** — `docker compose pull && docker compose up -d` (14 contenedores)
2. **Threshold = 1** y **Start Mining** desde el frontend
3. **Esperar deposit** — primer miner hace tx on-chain → cuenta `miner-X` con BTC
4. **SELL** desde miner-5 (0.5 BTC @ $50k) y **BUY** desde client_1 (0.5 BTC @ $50k)
5. **Match** instantáneo — verificar en *Completed Trades*
6. **Owner fee** sube a 0.01 BTC (= 2 % del bruto)
7. **History** del buyer muestra `Buy BTC 0.49`, del seller `Sell BTC 0.50`
8. **Transfer BTC Out** del buyer hacia un address regtest nuevo
9. **History** del buyer muestra `Transfer BTC` con txid real
10. **Verificación on-chain** — `bitcoin-cli gettransaction <txid>` lo confirma

<div class="key">
<b>El BTC nace, entra al exchange, se negocia, queda registrado y sale.</b> Todo el ciclo es observable en tiempo real desde la UI y verificable en la blockchain.
</div>

---

## 9. Cierre · valor del sistema

<div class="row">
<div class="col box">
<b>Phase 1</b>
Blockchain real, mining competitivo, maduración y entrada al exchange verificada on-chain.
</div>
<div class="col box alt">
<b>Phase 2</b>
Mercado interno con balances reservados, matching price-time y fee del owner.
</div>
<div class="col box green">
<b>Phase 3</b>
Trazabilidad por cuenta + retiro on-chain. Historial completo y auditable.
</div>
</div>

<br>

**Entregables**

- Código fuente en D2L + `README.txt` con miembros, contribuciones y comandos
- Imágenes Docker Hub multi-arch (`linux/amd64`, `linux/arm64`):
  - `byandyx/btc-backend:proyecto-final` · `:latest`
  - `byandyx/btc-frontend:proyecto-final` · `:latest`
  - `byandyx/btc-miner:proyecto-final` · `:latest`
- Ejecución de grading: `docker compose pull && docker compose up -d` (sin build local)

<div class="key">
El proyecto integra <b>blockchain</b>, <b>exchange interno</b> y <b>auditoría por historial</b> en un sistema coherente, contenedorizado y reproducible.
</div>

---

<!-- _paginate: false -->
<!-- _header: '' -->
<!-- _footer: '' -->

# Gracias

### Preguntas

<br>

**Andrés Proaño · Pablo Alvarado**

Repositorio · `byandyx/btc-{backend,frontend,miner}:proyecto-final`
