# REGOLE NASCONDINO — DOJO Code

> Regolamento Completo

-----

## 1. Struttura Generale

La partita è divisa in turni di **Giorno** e **Notte**. Il numero totale viene deciso dal master prima dell'inizio.

> **Esempio:** 5 giorni + 5 notti

**La partita termina quando:**

- finiscono tutti i turni, oppure
- tutti i sopravvissuti vengono convertiti in cercatori

-----

## 2. Squadre

### 🙈 Sopravvissuti

- Nascondersi
- Evitare i cercatori
- Sopravvivere fino alla fine della partita

### 🔍 Cercatori

- Trovare i sopravvissuti
- Convertirli nella propria squadra

### 💊 Medici

Sono sopravvissuti speciali assegnati casualmente dal sistema.

- Cambiano ogni notte
- Solo loro sanno di essere medici
- Non possono curarsi da soli

**Numero medici per notte**

Formula: `Numero medici = floor(sopravvissuti vivi × 10%)`

|Sopravvissuti vivi|Numero medici|
|------------------|-------------|
|30                |3 medici     |
|18                |1 medico     |
|< 10              |0 medici     |


> **Regola soglia:** minimo 1 medico se i sopravvissuti vivi sono almeno 10. Zero medici sotto i 10 sopravvissuti vivi.

-----

## 3. Inizio Partita

All'inizio della partita il sistema esegue automaticamente:

- Genera i codici univoci per tutti i giocatori
- Sceglie casualmente il primo cercatore
- Assegna casualmente i medici della prima notte

**Ogni giocatore riceve:**

- Un nickname
- Un codice personale univoco

> Il codice serve per essere preso dai cercatori e per essere curato dai medici.

-----

## 4. Le Fasi di Gioco

### ☀️ Fase Giorno — circa 1 minuto

- I cercatori **NON** possono prendere
- I sopravvissuti possono spostarsi liberamente
- I giocatori possono riorganizzarsi

All'inizio di ogni giorno vengono annunciati i giocatori convertiti durante la notte precedente. Da quel momento diventano cercatori attivi.

### 🌙 Fase Notte — circa 8 minuti

- I cercatori possono cacciare
- I sopravvissuti devono nascondersi
- I medici possono curare

**Questa è la fase principale del gioco.**

-----

## 5. Sistema di Presa

Quando un cercatore trova un sopravvissuto:

1. Il sopravvissuto mostra il proprio codice
1. Il cercatore inserisce il codice nell'app
1. Il giocatore entra nello stato **"Ferito"**

**Stato Ferito:**

- ✅ Può continuare a muoversi
- ✅ Può cercare un medico
- ❌ NON è ancora convertito
- ❌ NON può essere preso una seconda volta
- ⚠️ Ha solo quella notte per salvarsi

-----

## 6. Sistema di Cura

Per essere salvato, il giocatore ferito deve trovare un medico **prima della fine della notte**.

**Procedura di cura:**

1. Il medico apre la schermata cura nell'app
1. Inserisce il codice del giocatore ferito
1. Il sistema conferma la cura

**Se la cura riesce:**

- Il giocatore torna sopravvissuto normale
- Il sistema genera automaticamente un nuovo codice personale

> Il nuovo codice previene: cheating, riutilizzo dei codici, cure false.

-----

## 7. Conversione

Alla fine di ogni notte:

|Esito                  |Conseguenza                 |
|-----------------------|----------------------------|
|✅ Curato entro la notte|Resta sopravvissuto         |
|❌ Non curato           |Viene convertito → Cercatore|

La conversione viene annunciata all'inizio del giorno successivo.

-----

## 8. Regole Importanti

**I medici cambiano ogni notte**
Impedisce camperaggio, basi sicure permanenti e protezione infinita.

**I medici non possono curarsi da soli**
Altrimenti il ruolo diventerebbe troppo forte e squilibrato.

**La cura vale solo nella notte della presa**
Se arriva il giorno senza essere stati curati, la conversione è definitiva.

**I cercatori non conoscono i medici**
Devono scoprirli giocando.

**I medici possono scegliere se rivelarsi**
Questo crea bluff, tradimenti e tensione sociale — una delle parti più interessanti del gioco.

-----

## 9. Condizioni di Vittoria

|🟢 Vittoria Sopravvissuti                               |🔴 Vittoria Cercatori                             |
|-------------------------------------------------------|-------------------------------------------------|
|Almeno un sopravvissuto in vita alla fine della partita|Tutti i sopravvissuti convertiti prima della fine|
