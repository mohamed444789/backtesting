import React,{useEffect,useMemo,useRef,useState}from'react';
import {CalendarDays,ChevronDown,ChevronLeft,ChevronRight} from 'lucide-react';
import './date-picker.css';

type CalendarDatePickerProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  minDate?: string;
  maxDate?: string;
};

type CalendarView = 'days' | 'months' | 'years';

const parseDate = (value?: string): Date | null => {
  if (!value) return null;
  const parts = value.split('-').map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return null;
  const [year, month, day] = parts;
  const result = new Date(year, month - 1, day);
  if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day) return null;
  return result;
};

const toDateValue = (date: Date) =>
  date.getFullYear() + '-' +
  String(date.getMonth() + 1).padStart(2, '0') + '-' +
  String(date.getDate()).padStart(2, '0');

const startOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);

const formatDate = (date: Date, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, options).format(date);

export default function CalendarDatePicker({
  label,
  value,
  onChange,
  minDate,
  maxDate
}: CalendarDatePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedDate = parseDate(value);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<CalendarView>('days');
  const [visibleMonth, setVisibleMonth] = useState<Date>(() => startOfMonth(selectedDate ?? new Date()));
  const [yearRangeStart, setYearRangeStart] = useState(() => Math.floor((selectedDate ?? new Date()).getFullYear() / 10) * 10);

  useEffect(() => {
    if (!open) {
      const current = parseDate(value);
      if (current) setVisibleMonth(startOfMonth(current));
    }
  }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const firstDay = useMemo(() => new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1), [visibleMonth]);
  const calendarDays = useMemo(() => {
    const mondayOffset = (firstDay.getDay() + 6) % 7;
    const gridStart = new Date(firstDay.getFullYear(), firstDay.getMonth(), 1 - mondayOffset);
    return Array.from({length: 42}, (_, index) =>
      new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index)
    );
  }, [firstDay]);

  const weekdayNames = useMemo(() =>
    Array.from({length: 7}, (_, index) =>
      formatDate(new Date(2024, 0, 1 + index), {weekday: 'short'})
    ), []);

  const todayValue = toDateValue(new Date());
  const monthLabels = useMemo(() =>
    Array.from({length: 12}, (_, month) => formatDate(new Date(visibleMonth.getFullYear(), month, 1), {month: 'short'})),
    [visibleMonth]);

  const navigate = (direction: number) => {
    if (view === 'days') {
      setVisibleMonth(current => new Date(current.getFullYear(), current.getMonth() + direction, 1));
    } else if (view === 'months') {
      setVisibleMonth(current => new Date(current.getFullYear() + direction, current.getMonth(), 1));
    } else {
      setYearRangeStart(current => current + direction * 10);
    }
  };

  const periodLabel = view === 'days'
    ? formatDate(visibleMonth, {month: 'long', year: 'numeric'})
    : view === 'months'
      ? String(visibleMonth.getFullYear())
      : yearRangeStart + ' – ' + (yearRangeStart + 9);

  const chooseDate = (date: Date) => {
    const nextValue = toDateValue(date);
    if (minDate && nextValue < minDate) return;
    if (maxDate && nextValue > maxDate) return;
    onChange(nextValue);
    setVisibleMonth(startOfMonth(date));
    setView('days');
    setOpen(false);
  };

  const selectedSummaryDate = selectedDate ?? visibleMonth;
  const dateIsDisabled = (date: Date) => {
    const candidate = toDateValue(date);
    return (!!minDate && candidate < minDate) || (!!maxDate && candidate > maxDate);
  };

  return <div className="atlas-date-field">
    <span className="atlas-date-label">{label}</span>
    <div className="atlas-date-picker" ref={rootRef}>
      <button
        className="atlas-date-trigger"
        type="button"
        aria-label={'Choose ' + label.toLowerCase()}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            const current = parseDate(value) ?? new Date();
            setVisibleMonth(startOfMonth(current));
            setYearRangeStart(Math.floor(current.getFullYear() / 10) * 10);
            setView('days');
          }
          setOpen(current => !current);
        }}
      >
        <span>{selectedDate ? formatDate(selectedDate, {day: '2-digit', month: 'short', year: 'numeric'}) : 'Select date'}</span>
        <CalendarDays size={17} aria-hidden="true"/>
      </button>
      {open && <div className="atlas-calendar-popover" role="dialog" aria-label={'Choose ' + label.toLowerCase()}>
        <div className="atlas-calendar-summary">
          <div className="atlas-calendar-summary-text">
            <span>{label}</span>
            <strong>{formatDate(selectedSummaryDate, {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'})}</strong>
          </div>
          <button
            className="atlas-calendar-summary-toggle"
            type="button"
            aria-label={view === 'days' ? 'Choose month and year' : 'Return to calendar'}
            onClick={() => setView(current => current === 'days' ? 'months' : 'days')}
          ><ChevronDown size={17}/></button>
        </div>

        <div className="atlas-calendar-navigation">
          <button type="button" className="atlas-calendar-arrow" aria-label="Previous period" onClick={() => navigate(-1)}><ChevronLeft size={17}/></button>
          <button
            type="button"
            className="atlas-calendar-period"
            onClick={() => {
              if (view === 'days') setView('months');
              else if (view === 'months') {
                setYearRangeStart(Math.floor(visibleMonth.getFullYear() / 10) * 10);
                setView('years');
              } else setView('days');
            }}
          >{periodLabel}</button>
          <button type="button" className="atlas-calendar-arrow" aria-label="Next period" onClick={() => navigate(1)}><ChevronRight size={17}/></button>
        </div>

        {view === 'days' && <div className="atlas-calendar-day-view">
          <div className="atlas-calendar-weekdays">{weekdayNames.map((day, index) => <span key={index}>{day}</span>)}</div>
          <div className="atlas-calendar-days" role="grid">
            {calendarDays.map((date, index) => {
              const dateValue = toDateValue(date);
              const isSelected = dateValue === value;
              const isToday = dateValue === todayValue;
              const isOutsideMonth = date.getMonth() !== visibleMonth.getMonth();
              const disabled = dateIsDisabled(date);
              return <button
                key={dateValue}
                type="button"
                role="gridcell"
                aria-label={formatDate(date, {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})}
                aria-pressed={isSelected}
                disabled={disabled}
                className={[
                  'atlas-calendar-day',
                  isSelected ? 'selected' : '',
                  isToday ? 'today' : '',
                  isOutsideMonth ? 'outside-month' : ''
                ].filter(Boolean).join(' ')}
                onClick={() => chooseDate(date)}
              >{date.getDate()}</button>;
            })}
          </div>
        </div>}

        {view === 'months' && <div className="atlas-calendar-months" role="grid">
          {monthLabels.map((month, index) => <button
            key={month + index}
            type="button"
            className={index === visibleMonth.getMonth() ? 'selected' : ''}
            onClick={() => {
              setVisibleMonth(current => new Date(current.getFullYear(), index, 1));
              setView('days');
            }}
          >{month}</button>)}
        </div>}

        {view === 'years' && <div className="atlas-calendar-years" role="grid">
          {Array.from({length: 12}, (_, index) => yearRangeStart - 1 + index).map(year => <button
            key={year}
            type="button"
            className={year === visibleMonth.getFullYear() ? 'selected' : ''}
            onClick={() => {
              setVisibleMonth(current => new Date(year, current.getMonth(), 1));
              setView('months');
            }}
          >{year}</button>)}
        </div>}

        <div className="atlas-calendar-footer">
          <button type="button" disabled={dateIsDisabled(new Date())} onClick={() => chooseDate(new Date())}>Today</button>
        </div>
      </div>}
    </div>
  </div>;
}
