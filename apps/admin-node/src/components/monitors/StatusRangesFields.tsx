import { Field } from '@better-forge/ui'

export type StatusRange = { min: number; max: number }

/** Cloudflare supports the range settings already available in the legacy editor. */
export function StatusRangesFields({ ranges, onChange }: { ranges: StatusRange[]; onChange: (ranges: StatusRange[]) => void }) {
  function update(index: number, patch: Partial<StatusRange>) {
    onChange(ranges.map((range, at) => at === index ? { ...range, ...patch } : range))
  }

  return <div className="space-y-2">
    <div className="text-xs font-medium">Accepted status ranges (optional)</div>
    <p className="text-xs">When ranges are configured, they replace the single expected status. Redirects with a Location header are blocked even when their status is accepted.</p>
    {ranges.map((range, index) => <fieldset key={index} className="space-y-2">
      <legend className="text-sm">Status range {index + 1}</legend>
      <div className="grid grid-cols-2 gap-2">
        <Field label="From"><input aria-label={`Status range ${index + 1} from`} type="number" min={100} max={599} value={range.min || ''} onChange={event => update(index, { min: Number(event.target.value) })} className="input-sig" /></Field>
        <Field label="To"><input aria-label={`Status range ${index + 1} to`} type="number" min={100} max={599} value={range.max || ''} onChange={event => update(index, { max: Number(event.target.value) })} className="input-sig" /></Field>
      </div>
      <button type="button" className="btn btn-outline btn-sm" onClick={() => onChange(ranges.filter((_, at) => at !== index))}>Remove status range {index + 1}</button>
    </fieldset>)}
    <button type="button" className="btn btn-outline btn-sm" disabled={ranges.length >= 20} onClick={() => onChange([...ranges, { min: 200, max: 299 }])}>Add status range</button>
  </div>
}

export function statusRangesProblem(ranges: StatusRange[]): string | null {
  if (ranges.length > 20 || ranges.some(range => !Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min < 100 || range.max > 599 || range.min > range.max)) {
    return 'Each status range must have a start and end from 100 to 599, with the start no greater than the end.'
  }
  return null
}
