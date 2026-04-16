# Probis — AI-Assisted Prediction Market Trading System

## Overview

Probis is a predictive trading and execution-assistant system for Polymarket US. It combines live market data, deterministic probability modeling, and LLM signal extraction to identify potential mispricings, assist execution, and monitor risk in real time.

---

## Core Goals

* Fetch and display real-time prediction market data
* Analyze all outcomes for a given event
* Identify the highest-conviction risk-adjusted opportunity
* Assist user in executing and managing trades
* Provide automated monitoring with configurable exits and manual overrides

---

## Tech Stack

* Backend: Node.js / Express
* Frontend: React
* LLM: Ollama (Gemma model)
* Data Sources:

  * Polymarket US authenticated API
  * Gamma / market metadata sources
  * Live news APIs (optional)
  * Social sentiment feeds (optional)
* Storage:

  * Current: local JSON store for intents
  * Planned: PostgreSQL for durable tracking and analytics

---

## Step-by-Step Implementation Plan

### Step 1 — Environment Setup

* Configure `.env`:

  * `POLYMARKET_US_KEY_ID=`
  * `POLYMARKET_US_SECRET_KEY=`
  * `POLYMARKET_US_BASE_URL=`
  * `OLLAMA_BASE_URL=`
  * `OLLAMA_MODEL=`
* Verify Node/Ollama runtime and API connectivity
* Install dependencies and run local dev stack

---

### Step 2 — Connect to Polymarket API

* Authenticate using signed Ed25519 headers
* Validate endpoints:

  * Markets list and market-by-slug
  * Orders create
  * Portfolio positions
  * Account balances and buying power
* Validate payload shape and fallback parsing for schema variations

---

### Step 3 — Event Input System

* User inputs:

  * Polymarket event URL or slug
* Parse:

  * Event slug
* Fetch:

  * Event markets and outcomes
* Add robust slug canonicalization (for example, prefixed slug variants)

---

### Step 4 — Market Display UI

* Display:

  * Event title and description
  * Outcomes and current probabilities
  * Liquidity/volume snapshots
* Handle:

  * Binary and multi-outcome markets cleanly
  * Monitoring-first mode when active positions exist

---

### Step 5 — Data Aggregation Layer

* Collect:

  * Historical price data
  * Volume / liquidity
  * Market-quality features
  * Optional external signals (news, sentiment)
* Normalize into structured feature objects with cache support

---

### Step 6 — AI Analysis Pipeline

#### 6.1 Statistical Model

* Estimate fair probability using:

  * Current price and momentum
  * Historical anchor behavior
  * Volatility penalties
  * Quality and sample-strength weighting

#### 6.2 LLM Signal Extraction (Ollama Gemma)

* Input:

  * Aggregated market state
  * Optional external context
* Output:

  * Structured recommendation reasoning
  * Confidence and key risk summary

#### 6.3 Decision Engine

* Combine:

  * Statistical estimate
  * LLM confidence/agreement
* Output:

  * Recommended opportunity
  * EV and edge
  * Action (`buy`, `watch`, `avoid`)

#### 6.4 Calibration + Uncertainty

* Add probability calibration (rolling)
* Track confidence reliability and uncertainty bands

#### 6.5 Backtesting + Walk-Forward Validation

* Evaluate strategy on historical windows
* Report EV, hit rate, drawdown, and robustness by regime

---

### Step 7 — Trade Suggestion Interface

* Display:

  * Recommended outcome
  * Reasoning and confidence
  * Current price and projected P/L metrics
* Prompt user:

  * Enter stake and review trade suggestion

---

### Step 8 — Risk Management System

* Suggest:

  * Stop-loss probability
  * Take-profit probability
* Allow user to:

  * Edit values
  * Accept defaults

### Step 8.1 — Portfolio Risk Limits

* Enforce:

  * Max per-position exposure
  * Max concurrent positions
  * Max daily loss / session kill-switch

---

### Step 9 — Trade Execution

* Place trades via Polymarket US API
* Persist:

  * Entry order metadata
  * Position size and notional spent
  * Risk parameters
* Implement fallback execution paths (for example, market-to-limit fallback when required)

### Step 9.1 — Execution Quality

* Measure:

  * Fill quality
  * Slippage
  * Time-to-fill
  * Partial fill behavior

---

### Step 10 — Live Trade Monitoring

* Continuously track:

  * Current probability
  * Drift and unrealized P/L
* Trigger:

  * Take-profit exits
  * Stop-loss exits

### Step 10.1 — Monitoring + Alerting

* Add alerts for:

  * Poll failures
  * Stale data
  * API/auth errors
  * Model drift signals

---

### Step 11 — Optional Automation Features

* Light automation:

  * Rule-based scaling in/out
* Manual override:

  * Sell Now
  * Stop Trade
  * Close Intent

---

### Step 12 — UI Dashboard

* Sections:

  * Trade Center (all/tracking/closed filters)
  * Event analysis + recommendations
  * Active monitoring metrics
* Frequent updates and monitor-first workflow after execution

---

### Step 13 — Post-Trade Analytics + Feedback Loop

* Attribute outcomes by:

  * Model signal quality
  * Execution quality
  * Timing decisions
* Feed insights back into model/risk tuning

---

## Future Features

* PostgreSQL migration for durable intent/position history
* Live news + social feed integration
* Advanced calibration and regime-aware ensembles
* Multi-market scanning and ranking
* Portfolio analytics and exposure dashboards
* Canary rollouts and rollback controls for model updates

---

## Risks & Considerations

* API trading restrictions (Polymarket US)
* Market liquidity and fill-quality risk
* Model overfitting / calibration drift
* Execution timing vs signal latency
* Regulatory and compliance requirements

---

## MVP Definition

A working MVP includes:

* Event input and resolution
* Market display and recommendation generation
* Live trade execution via API
* Trade Center monitoring with manual overrides
* Basic stop-loss / take-profit handling

---

## Long-Term Vision

Probis evolves into a semi-autonomous trading assistant that:

* Continuously scans and ranks opportunities
* Quantifies edge with calibrated probabilities
* Assists users with execution and disciplined risk control

---