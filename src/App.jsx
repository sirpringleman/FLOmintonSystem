import React, { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabaseClient'
import { formatTime, selectPlayersForRound, buildMatchesFrom16 } from './logic'

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient'

// 🔎 DIAGNOSTICS — TEMPORARY
console.log('ENV CHECK => SUPABASE_URL:', SUPABASE_URL)
console.log('ENV CHECK => ANON KEY length:', (SUPABASE_ANON_KEY||'').length)

async function diag() {
  try {
    // 1) Prove general network from your Netlify site works
    const ping = await fetch('https://jsonplaceholder.typicode.com/todos/1')
    console.log('Network test status (should be 200):', ping.status)

    // 2) Direct REST probe to your Supabase REST endpoint
    const restUrl = `${SUPABASE_URL}/rest/v1/players?select=*`
    console.log('REST URL:', restUrl)

    const r = await fetch(restUrl, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    })
    console.log('REST status:', r.status)
    const bodyText = await r.text()
    console.log('REST body (truncated):', bodyText.slice(0, 200))

  } catch (e) {
    console.error('DIAG exception:', e)
  }
}

diag()


console.log('ENV CHECK => URL:', supabase?.rest?.url)

// simple audio beeps via WebAudio (works after first user click)
function useBeep() {
  const ctxRef = useRef(null)
  const ensure = () => {
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)()
    return ctxRef.current
  }
  const beep = (freq=800, ms=250) => {
    const ctx = ensure()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.connect(g); g.connect(ctx.destination)
    o.type = 'sine'; o.frequency.value = freq
    o.start()
    g.gain.setValueAtTime(0.2, ctx.currentTime)
    o.stop(ctx.currentTime + ms/1000)
  }
  return { beep }
}

export default function App() {
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(true)
  const [round, setRound] = useState(0)
  const [timeLeft, setTimeLeft] = useState(12*60) // 12 minutes
  const [running, setRunning] = useState(false)
  const [matches, setMatches] = useState([])
  const timerRef = useRef(null)
  const lastRoundBenched = useRef(new Set()) // for fairness tie-break
  const teammateHistory = useRef(new Map())  // to reduce teammate repeats
  const { beep } = useBeep()

  // Load players
  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase
          .from('players')
          .select('*')
          .order('name')
  
        console.log('🔎 Supabase client select => data:', data, 'error:', error)
  
        if (error) {
          alert('Supabase error: ' + (error.message || JSON.stringify(error)))
          console.error('❌ Supabase select error:', error)
        }
  
        setPlayers(data || [])
      } catch (e) {
        alert('Unexpected error: ' + (e.message || e))
        console.error('❌ Unexpected fetch error:', e)
      } finally {
        setLoading(false)
      }
    })()
  }, [])
  

  const present = useMemo(() => players.filter(p => p.is_present), [players])
  const notPresent = useMemo(() => players.filter(p => !p.is_present), [players])

  // Double-click toggle presence
  const togglePresence = async (p) => {
    const newVal = !p.is_present
    const { error } = await supabase.from('players').update({ is_present: newVal }).eq('id', p.id)
    if (error) return alert('Failed to toggle presence')
    setPlayers(prev => prev.map(x => x.id===p.id ? {...x, is_present:newVal} : x))
  }

  // Build next round (select players, generate matches, update DB)
  const buildNextRound = async () => {
    if (present.length < 4) return alert('Not enough players present.')
    const roundNumber = round + 1

    // Select 16 to play, rest benched
    const { playing, benched } = selectPlayersForRound(present, roundNumber, lastRoundBenched.current)
    lastRoundBenched.current = new Set(benched.map(b => b.id))

    // Generate balanced matches (±2 first, else balance by average)
    const newMatches = buildMatchesFrom16(playing, teammateHistory.current)
    setMatches(newMatches)
    setRound(roundNumber)

    // Persist: increment bench_count for benched; update last_played_round for playing
    const playingIds = playing.map(p=>p.id)
    const benchedIds = benched.map(p=>p.id)

    if (playingIds.length) {
      const { error } = await supabase.from('players')
        .update({ last_played_round: roundNumber })
        .in('id', playingIds)
      if (error) console.error('update playing failed', error)
    }

    if (benchedIds.length) {
      // we need current bench_count; easiest is to patch each (batched is more advanced)
      const updates = benched.map(b => ({
        id: b.id,
        bench_count: (b.bench_count || 0) + 1
      }))
      for (const u of updates) {
        const { error } = await supabase.from('players').update({ bench_count: u.bench_count }).eq('id', u.id)
        if (error) console.error('bench update failed', error)
      }
    }

    // Refresh local state
    const { data } = await supabase.from('players').select('*').order('name')
    setPlayers(data || [])
  }

  // Timer control
  const startTimer = () => {
    clearInterval(timerRef.current)
    setTimeLeft(12*60)
    setRunning(true)
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        const next = prev - 1
        if (next === 30) beep(1200, 300) // 30s warning
        if (next <= 0) {
          clearInterval(timerRef.current)
          beep(500, 500)   // end round
          setRunning(false)
          // Auto next round
          setTimeout(() => {
            buildNextRound().then(() => startTimer())
          }, 400)
          return 0
        }
        return next
      })
    }, 1000)
  }

  const handleStart = async () => {
    // make sure we have players loaded
    if (present.length < 16) {
      const proceed = confirm(`Only ${present.length} present; less than 16 means fewer courts.\nProceed anyway?`)
      if (!proceed) return
    }
    await buildNextRound()
    startTimer()
  }
  const handlePause = () => { if (running) { clearInterval(timerRef.current); setRunning(false) } }
  const handleResume = () => { if (!running && timeLeft>0) { startTimer() } }
  const handleEnd = () => { clearInterval(timerRef.current); setRunning(false); setTimeLeft(12*60); setMatches([]); setRound(0) }
  const handleNext = async () => { clearInterval(timerRef.current); setRunning(false); await buildNextRound(); startTimer() }

  // Render helpers
  const personRow = (p) => {
    const pill = p.gender === 'F' ? 'female' : 'male'
    return (
      <div key={p.id} className="person" onDoubleClick={()=>togglePresence(p)} title="Double-click to toggle">
        <div>{p.name} <span className={`pill ${pill}`}>{p.gender}</span></div>
        <div>Lvl {p.skill_level}</div>
      </div>
    )
  }

  const Court = ({ m }) => {
    const tag = (pl) => {
      const pill = pl.gender === 'F' ? 'female' : 'male'
      return <div className="tag"><span className={`pill ${pill}`}>{pl.gender}</span>{pl.name} (L{pl.skill_level})</div>
    }
    return (
      <div className="court">
        <h3>Court {m.court}</h3>
        <div className="team">{m.team1.map(tag)}</div>
        <div className="avg">Avg: {m.avg1.toFixed(1)}</div>
        <div className="net"></div>
        <div className="team">{m.team2.map(tag)}</div>
        <div className="avg">Avg: {m.avg2.toFixed(1)}</div>
      </div>
    )
  }

  // wire up header buttons by id (since header is outside React root in this simple template)
  useEffect(() => {
    const s = document.getElementById('startBtn')
    const p = document.getElementById('pauseBtn')
    const r = document.getElementById('resumeBtn')
    const e = document.getElementById('endBtn')
    const n = document.getElementById('nextBtn')
    s.onclick = handleStart
    p.onclick = handlePause
    r.onclick = handleResume
    e.onclick = handleEnd
    n.onclick = handleNext
    return () => { s.onclick=p.onclick=r.onclick=e.onclick=n.onclick=null }
  }, [present, timeLeft, running])

  // update timer text outside react for snappy display
  useEffect(() => {
    const el = document.getElementById('timerText')
    el.textContent = formatTime(timeLeft)
  }, [timeLeft])

  if (loading) return <div style={{padding:16}}>Loading…</div>

  return (
    <div style={{padding:16}}>
      <div style={{marginBottom:8}}>Round: <b>{round === 0 ? '–' : round}</b></div>
      <div className="lists">
        <div id="allList" className="list">
          {notPresent.map(personRow)}
        </div>
        <div id="presentList" className="list">
          {present.map(personRow)}
        </div>
      </div>

      <div style={{height:8}}></div>

      <div id="courts" className="courts">
        {matches.map(m => <Court key={m.court} m={m} />)}
      </div>
    </div>
  )
}