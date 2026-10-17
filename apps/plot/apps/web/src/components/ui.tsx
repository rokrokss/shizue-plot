import type {
  ComponentPropsWithRef,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

export const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(' ');

/* `relative` is for the busy spinner, which lies over the label rather than beside it. */
const BUTTON_BASE =
  'relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl body14 font-medium ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-focus';

const BUTTON_VARIANTS = {
  primary: 'border border-transparent bg-accent text-accent-ink hover:bg-accent-hover disabled:bg-raised disabled:text-muted disabled:opacity-100',
  secondary: 'border border-transparent bg-raised text-fg hover:bg-line',
  ghost: 'border border-transparent text-muted hover:bg-raised hover:text-fg',
  danger: 'border border-danger/40 text-danger hover:bg-danger/10',
} as const;

const BUTTON_SIZES = {
  sm: 'h-9 px-3',
  md: 'h-11 px-4',
} as const;

/* The button's own look, for the links that have to stand as one — the header's
 * way in, which is a navigation and so an anchor, not a button. */
export function buttonClass(
  variant: keyof typeof BUTTON_VARIANTS = 'secondary',
  size: keyof typeof BUTTON_SIZES = 'md',
  className?: string,
): string {
  return cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);
}

/* Takes a ref: a menu has to put the focus back on the button that opened it. */
interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
  /** Working on the last press: disables, and lays a spinner over the label. */
  busy?: boolean;
}

/*
 * The label stays put while the button works — a button that renames itself or
 * grows a spinner mid-press is one the reader has to read twice. So busy hides
 * the label with opacity rather than removing it: the box is still the label's
 * size, and the accessible name is still the label (opacity leaves the AT tree
 * alone). The spinner over it is decoration — `aria-busy` is what says the
 * button is working.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={buttonClass(variant, size, className)}
    >
      {busy ? <span className="opacity-0">{children}</span> : children}
      {busy ? <Spinner className="absolute inset-0 m-auto" /> : null}
    </button>
  );
}

const CONTROL_BOX =
  'control-box rounded-xl border bg-surface text-fg placeholder:text-muted ' +
  'transition-colors focus:border-focus focus:outline-2 focus:outline-offset-1 focus:outline-focus/25 disabled:opacity-60';
const CONTROL = cx(CONTROL_BOX, 'px-3.5');

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(CONTROL, className)} />;
}

/* Takes a ref: the composer has to read and move the caret to wrap a selection. */
export function TextArea({ className, ...props }: ComponentPropsWithRef<'textarea'>) {
  return <textarea {...props} className={cx(CONTROL, 'resize-y leading-relaxed', className)} />;
}

/* Its side padding is the global `select` rule's: 14px of it, as the other controls have, and room for the ⌄. */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(CONTROL_BOX, 'cursor-pointer', className)} />;
}

/*
 * Who a field is written for. `public` is read by other users, `ai` never leaves
 * the prompt — the one distinction a creator has to hold in their head, so the
 * editors label every field with it. Text labels carry the meaning in every palette.
 */
const BADGE_TONES = {
  public: 'border-fg/40 text-fg/85',
  ai: 'border-line text-muted',
} as const;

export function Badge({
  tone = 'ai',
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs leading-none whitespace-nowrap',
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  badge,
  children,
}: {
  label: string;
  hint?: string;
  /** Sits beside the label; the audience badges are what it carries. */
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted">{label}</span>
        {badge}
      </span>
      {children}
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cx(
        'flex items-center gap-2 text-sm text-muted select-none',
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-accent"
      />
      {label}
    </label>
  );
}

export function Section({
  title,
  action,
  busy = false,
  children,
}: {
  title: string;
  action?: ReactNode;
  /** Lock the request's inputs and actions together, including nested editors. */
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-busy={busy || undefined} className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <fieldset disabled={busy} className="min-w-0">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="heading3 text-fg">{title}</h2>
          {action}
        </div>
        <div className="space-y-4">{children}</div>
      </fieldset>
    </section>
  );
}

/*
 * Always in the page, empty until there is something to say: a live region only
 * announces what appears inside one that was already there, and an error that
 * mounts its own element arrives silently.
 */
export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p aria-live="polite" className="text-sm text-danger">
      {children}
    </p>
  );
}

/*
 * `label` is what a reader hears while they wait, and giving it is what makes
 * this a status rather than an ornament: a spinner standing alone for a page is
 * the only thing on screen and has to say so, one beside a word that already
 * says "저장 중…" would only say it twice.
 */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
      className={cx(
        'inline-block size-4 animate-spin rounded-full border-2 border-line border-t-accent',
        className,
      )}
    />
  );
}

export function CenteredMessage({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-10 text-sm text-muted">{children}</div>;
}
