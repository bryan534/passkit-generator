import { useState, useRef } from 'react'
import './App.css'

const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? ''

type State = 'idle' | 'loading' | 'success' | 'error'

function formatMemberSince(value: string): string {
  if (!value) {
    const now = new Date()
    return now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  }
  const [year, month, day] = value.split('-').map(Number)
  const d = new Date(year, month - 1, day)
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

export default function App() {
  const [name, setName] = useState('')
  const [memberId, setMemberId] = useState('')
  const [memberSince, setMemberSince] = useState('')
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [cooldown, setCooldown] = useState(false)
  const anchorRef = useRef<HTMLAnchorElement>(null)

  const memberIdValid = /^\d{5,12}$/.test(memberId.trim())
  const memberIdDirty = memberId.length > 0
  const canSubmit = name.trim() && memberIdValid && !cooldown

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!canSubmit) return

    setState('loading')
    setErrorMsg('')

    try {
      const res = await fetch(`${WORKER_URL}/api/pass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          id: memberId.trim(),
          memberSince: formatMemberSince(memberSince),
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        console.error(`Pass generation failed (${res.status}):`, text)
        throw new Error(res.status === 429 ? 'Too many requests — try again in a moment.' : 'Something went wrong. Please try again.')
      }

      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = anchorRef.current!
      a.href = objectUrl
      a.download = 'evolutions-membership.pkpass'
      a.click()
      URL.revokeObjectURL(objectUrl)

      setState('success')
      setCooldown(true)
      setTimeout(() => setCooldown(false), 10_000)
    } catch (err) {
      console.error('Pass generation error:', err)
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setState('error')
    }
  }

  function reset() {
    setState('idle')
    setErrorMsg('')
    setName('')
    setMemberId('')
    setMemberSince('')
  }

  return (
    <>
      <div className="bg-glow" />
      <a ref={anchorRef} style={{ display: 'none' }} aria-hidden />

      <div className="card">
        <img src="/logo.png" alt="Evolutions Fitness & Wellness Center" className="gym-logo" />
        <div className="divider" />

        <div className="fade-in" key={state === 'success' ? 'success' : 'form'}>
          {state === 'success' ? (
            <div className="success">
              <div className="success-icon">
                <svg className="checkmark" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle className="checkmark-circle" cx="26" cy="26" r="24" stroke="#22c55e" strokeWidth="2.5"/>
                  <path className="checkmark-check" d="M14 26l9 9 16-16" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <h2>Pass Ready</h2>
              <p>
                Your Evolutions membership pass has been downloaded.<br />
                Open it to add to Apple Wallet.
              </p>
              <button className="reset-btn" onClick={reset}>
                Generate Another
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate>
              <p className="card-title">Membership Pass</p>

              <div className="field">
                <label htmlFor="name">Member Name</label>
                <input
                  id="name"
                  type="text"
                  placeholder="John Smith"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  autoComplete="name"
                  autoCapitalize="words"
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="member-id">Membership #</label>
                <input
                  id="member-id"
                  type="text"
                  inputMode="numeric"
                  placeholder="100005821"
                  value={memberId}
                  onChange={e => setMemberId(e.target.value.replace(/\D/g, ''))}
                  required
                  aria-invalid={memberIdDirty && !memberIdValid}
                />
                {memberIdDirty && !memberIdValid && (
                  <p className="error-msg" style={{ marginTop: '0.4rem' }}>
                    Must be 5–12 digits
                  </p>
                )}
              </div>

              <div className="field">
                <label htmlFor="member-since">
                  Member Since
                  <span className="optional">optional</span>
                </label>
                <input
                  id="member-since"
                  type="date"
                  value={memberSince}
                  onChange={e => setMemberSince(e.target.value)}
                />
              </div>

              {state === 'error' && (
                <p className="error-msg">{errorMsg}</p>
              )}

              <button
                type="submit"
                className="submit-btn"
                disabled={!canSubmit || state === 'loading'}
              >
                {state === 'loading' ? (
                  <>
                    <div className="spinner" />
                    Generating…
                  </>
                ) : (
                  'Add to Apple Wallet'
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </>
  )
}
