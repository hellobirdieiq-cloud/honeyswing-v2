# HoneySwing V2 Architecture

## Goal

Build a clean, scalable architecture for HoneySwing that:

- keeps pose detection swappable
- separates UI from logic
- supports accurate swing analysis
- allows new features without breaking core systems
- enables benchmarking and evaluation

V2 is not a cleaner rewrite of V1.

V2 is a **system architecture upgrade**.

---

# Core Product Loop

1. Record swing
2. Upload video
3. Extract pose frames
4. Analyze swing
5. Produce score + feedback
6. Display results
7. Save session history

This loop must remain **extremely reliable and simple**.

---

# Core Domain Concepts

### Session
A user swing recording event.

Fields:

- id
- user_id
- created_at
- handedness
- device
- metadata

---

### MediaAsset
Stores the video associated with a session.

Fields:

- id
- session_id
- video_url
- duration
- resolution

---

### AnalysisJob
Represents the processing request.

Fields:

- id
- session_id
- pose_backend
- status
- created_at

Status values:

- pending
- processing
- complete
- failed

---

### PoseSequence
Normalized pose frames extracted from the video.

Contains:

- PoseFrame[]
- source backend
- frame metadata

---

### AnalysisResult
Output of the swing analysis.

Fields:

- score
- honey_boom
- summary
- feedback
- tip
- phase_metrics
- created_at

---

# System Layers

## UI Layer

Location:

