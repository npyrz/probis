# Probis — AI-Assisted Prediction Market Trading System

## Overview

Probis is a low-latency, AI-assisted trading system built for real-time prediction markets on Polymarket US. It combines live market data, probabilistic modeling, and LLM-based signal extraction to identify mispriced events and assist users in executing trades.

---

## Core Goals

* Fetch and display real-time prediction market data
* Analyze all outcomes for a given event
* Identify the most mispriced opportunity
* Assist user in executing and managing trades
* Provide automated monitoring with optional exit strategies

---

## Tech Stack

* Backend: Node.js / Express
* Frontend: React
* LLM: Ollama (Gemma model)
* Data Sources:

  * Polymarket US API
  * Live news APIs (optional)
  * Social sentiment feeds (optional)
* Storage: PostgreSQL (optional for tracking trades)

---

## Step-by-Step Implementation Plan

### Step 1 — Environment Setup

* Create `.env` file:

  * `POLYMARKET_API_KEY=`
  * `POLYMARKET_PRIVATE_KEY=`
* Install dependencies:

  * Polymarket US SDK
  * Axios / Fetch
  * WebSocket client (if available)

---

### Step 2 — Connect to Polymarket API

* Authenticate using API key
* Test endpoints:

  * Fetch all markets
  * Fetch single event by URL
* Validate response structure

---

### Step 3 — Event Input System

* User inputs:

  * Polymarket event URL
* Parse:

  * Event ID
* Fetch:

  * All market options (teams, players, etc.)

---

### Step 4 — Market Display UI

* Display:

  * Event title
  * All outcomes
  * Current prices (YES/NO or probabilities)
* Handle:

  * Multi-outcome markets cleanly

---

### Step 5 — Data Aggregation Layer

* Collect:

  * Historical price data (if available)
  * Volume / liquidity
  * External signals (news, sentiment)
* Normalize into structured format

---

### Step 6 — AI Analysis Pipeline

#### 6.1 Statistical Model

* Estimate “true probability” using:

  * Price inefficiencies
  * Market trends
  * Historical behavior

#### 6.2 LLM Signal Extraction (Ollama Gemma)

* Input:

  * Market data
  * News summaries
  * Social sentiment
* Output:

  * Confidence score per outcome
  * Reasoning

#### 6.3 Decision Engine

* Combine:

  * Statistical probability
  * LLM confidence
* Output:

  * Best trade opportunity
  * Expected value (EV)

---

### Step 7 — Trade Suggestion Interface

* Display:

  * Recommended option
  * Reasoning
  * Confidence level
* Prompt user:

  * “Enter amount to invest”

---

### Step 8 — Risk Management System

* Automatically suggest:

  * Stop-loss price
  * Take-profit price
* Allow user to:

  * Edit values
  * Accept defaults

---

### Step 9 — Trade Execution

* Place trade via Polymarket API (if permitted)
* Store:

  * Entry price
  * Position size
  * Risk parameters

---

### Step 10 — Live Trade Monitoring

* Continuously track:

  * Market price
* Trigger:

  * Sell at take-profit
  * Sell at stop-loss

---

### Step 11 — Optional Automation Features

* Light auto-trading:

  * Scale in/out positions
* Manual override:

  * “Sell Now” button
  * “Stop Bot” button

---

### Step 12 — UI Dashboard

* Sections:

  * Active trades
  * Market explorer
  * AI recommendations
* Real-time updates

---

## Future Features

* Polymarket account linking UI
* Live news + social feed integration
* Advanced probability models
* Multi-market scanning
* Portfolio analytics
* Fully automated trading (if API allows)

---

## Risks & Considerations

* API trading restrictions (Polymarket US)
* Market liquidity issues
* Model overfitting / bad signals
* Latency vs execution timing
* Regulatory compliance

---

## MVP Definition

A working MVP includes:

* Event input
* Market display
* AI-based recommendation
* Manual trade execution
* Basic monitoring

---

## Long-Term Vision

Probis evolves into a semi-autonomous trading assistant that:

* Continuously scans markets
* Identifies inefficiencies
* Assists users in making high-quality probabilistic trades

---
