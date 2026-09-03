import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { useI18n } from '@/i18n'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Tooltip } from '@/components/tooltip'
import type { PeakHoursConfig } from '@/lib/routing'

// A curated IANA list is friendlier than a free-text field (an invalid
// timezone is a silent 400 from the server). The current runtime zone is
// prepended so the toggle is usable out of the box on most installs.
const COMMON_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
  'Australia/Perth',
].sort()

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

function zoneOptions(current: string): string[] {
  const set = new Set([current, ...COMMON_ZONES])
  return [...set].sort()
}

/**
 * Peak-hours routing controls (#760): when enabled, the strategy shifts part of
 * a mixed preset's speed weight onto reliability inside the configured window.
 * The block is only shown in non-manual modes for the same reason the
 * exploration toggle is — Manual ignores the adjustment entirely.
 * Every change is an immediate PUT of the full patch (`peakHours`), so the
 * value always renders from the server's GET /routing snapshot.
 */
export function PeakHoursControls({ config, saving, onSave, exempt }: {
  config: PeakHoursConfig
  saving: boolean
  onSave: (patch: Partial<PeakHoursConfig>) => void
  /** True when the active strategy is excluded from the adjustment. */
  exempt: boolean
}) {
  const { t } = useI18n()
  const zones = zoneOptions(config?.timezone ?? localZone())

  // Local scratch for typed input; only committed to the server via onSave.
  // Kept in sync when the server snapshot changes externally.
  const [enabled, setEnabled] = useState(config.enabled)
  const [startHour, setStartHour] = useState(config.startHour)
  const [endHour, setEndHour] = useState(config.endHour)
  const [timezone, setTimezone] = useState(config.timezone ?? localZone())
  useEffect(() => {
    setEnabled(config.enabled)
    setStartHour(config.startHour)
    setEndHour(config.endHour)
    setTimezone(config.timezone ?? localZone())
  }, [config])

  const hoursValid =
    Number.isInteger(startHour) && startHour >= 0 && startHour <= 23 &&
    Number.isInteger(endHour) && endHour >= 0 && endHour <= 23

  function togglePeak(next: boolean) {
    setEnabled(next)
    onSave({ enabled: next })
  }

  return (
    <div className="mt-3 border-t pt-3">
      <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          checked={enabled}
          disabled={saving}
          onCheckedChange={togglePeak}
          aria-label={t('strategies.peakHours')}
        />
        <span className="inline-flex items-center gap-1.5 text-xs">
          <Clock className="size-3.5" />
          {t('strategies.peakHours')}
        </span>
        <Tooltip text={t('strategies.peakHoursHint')}>
          <span className="cursor-help underline decoration-dotted underline-offset-2">?</span>
        </Tooltip>
        {exempt && enabled && (
          <span className="text-[11px] text-muted-foreground">{t('strategies.peakHoursExempt')}</span>
        )}
      </label>

      {enabled && (
        <div className="mt-2 inline-flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t('strategies.peakWindow')}</span>
          <Input
            type="number"
            min={0}
            max={23}
            value={startHour}
            disabled={saving}
            onChange={e => {
              const v = e.target.valueAsNumber
              setStartHour(Number.isNaN(v) ? 0 : v)
              if (Number.isFinite(v) && v >= 0 && v <= 23) {
                // Start/end stream as one window; persist both so the pair looks
                // stable to the operator even before blur.
                onSave({ startHour: v, endHour, timezone })
              }
            }}
            className="w-16 px-2 py-1 text-xs"
            aria-label={t('strategies.peakStartHour')}
          />
          <span>–</span>
          <Input
            type="number"
            min={0}
            max={23}
            value={endHour}
            disabled={saving}
            onChange={e => {
              const v = e.target.valueAsNumber
              setEndHour(Number.isNaN(v) ? 0 : v)
              if (Number.isFinite(v) && v >= 0 && v <= 23) {
                onSave({ startHour, endHour: v, timezone })
              }
            }}
            className="w-16 px-2 py-1 text-xs"
            aria-label={t('strategies.peakEndHour')}
          />
          <Tooltip text={t('strategies.peakHoursWindowHint')}>
            <span className="cursor-help underline decoration-dotted underline-offset-2">?</span>
          </Tooltip>

          <select
            value={timezone}
            disabled={saving}
            onChange={e => {
              const tz = e.target.value
              setTimezone(tz)
              onSave({ startHour, endHour, timezone: tz })
            }}
            className="rounded-lg border bg-background px-2 py-1.5 text-xs text-foreground"
            aria-label={t('strategies.peakTimezone')}
          >
            {zones.map(z => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>

          {!hoursValid && (
            <span className="text-[11px] text-destructive">{t('strategies.peakHoursInvalid')}</span>
          )}
        </div>
      )}
    </div>
  )
}