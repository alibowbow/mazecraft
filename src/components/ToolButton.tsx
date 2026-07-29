import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react'

export type ToolButtonVariant = 'default' | 'primary' | 'danger' | 'quiet'
export type ToolButtonSize = 'compact' | 'regular'

export interface ToolButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode
  label: string
  active?: boolean
  variant?: ToolButtonVariant
  size?: ToolButtonSize
  hideLabel?: boolean
}

const variantStyles: Record<ToolButtonVariant, CSSProperties> = {
  default: {
    color: 'var(--mc-text, var(--ink, #172033))',
    background: 'var(--mc-control, var(--surface-2, #f2f4f8))',
    borderColor: 'var(--mc-border, var(--line, #d8dee9))',
  },
  primary: {
    color: '#ffffff',
    background: 'var(--mc-accent, var(--primary, #4f46e5))',
    borderColor: 'var(--mc-accent, var(--primary, #4f46e5))',
  },
  danger: {
    color: 'var(--mc-danger-text, var(--danger, #b4232c))',
    background: 'var(--mc-danger-soft, var(--surface-2, #fff1f2))',
    borderColor: 'var(--mc-danger-border, #fecdd3)',
  },
  quiet: {
    color: 'var(--mc-text, var(--ink, #172033))',
    background: 'transparent',
    borderColor: 'transparent',
  },
}

export const ToolButton = forwardRef<HTMLButtonElement, ToolButtonProps>(
  function ToolButton(
    {
      icon,
      label,
      active,
      variant = 'default',
      size = 'regular',
      hideLabel = false,
      className,
      style,
      type = 'button',
      disabled,
      ...buttonProps
    },
    ref,
  ) {
    const iconOnly = hideLabel
    const isActive = active === true
    return (
      <button
        {...buttonProps}
        ref={ref}
        type={type}
        disabled={disabled}
        className={`mc-tool-button${isActive ? ' is-active' : ''}${iconOnly ? ' is-icon-only' : ''}${className ? ` ${className}` : ''}`}
        aria-label={iconOnly ? label : buttonProps['aria-label']}
        aria-pressed={
          buttonProps['aria-pressed'] ?? (active !== undefined ? isActive : undefined)
        }
        title={iconOnly ? label : buttonProps.title}
        style={{
          minWidth: iconOnly ? 44 : undefined,
          minHeight: 44,
          height: size === 'compact' ? 44 : 46,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: iconOnly ? 0 : size === 'compact' ? '0 11px' : '0 14px',
          borderStyle: 'solid',
          borderWidth: 1,
          borderRadius: 11,
          font: 'inherit',
          fontSize: 14,
          fontWeight: 650,
          lineHeight: 1,
          whiteSpace: 'nowrap',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.52 : 1,
          boxShadow: isActive
            ? 'inset 0 0 0 2px var(--mc-focus, var(--focus, rgba(79, 70, 229, 0.3)))'
            : undefined,
          ...variantStyles[variant],
          ...style,
        }}
      >
        {icon ? (
          <span
            className="mc-tool-button__icon"
            style={{ display: 'inline-grid', placeItems: 'center', flex: '0 0 auto' }}
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : null}
        {!hideLabel ? <span className="mc-tool-button__label">{label}</span> : null}
      </button>
    )
  },
)
