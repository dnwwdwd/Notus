import * as TooltipPrimitive from '@radix-ui/react-tooltip';

export const Tooltip = ({ content, children }) => (
  <TooltipPrimitive.Provider delayDuration={180}>
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          style={{
            zIndex: 1400,
            background: 'var(--text-primary)',
            color: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 8px',
            fontSize: 'var(--text-xs)',
            lineHeight: 1.4,
            boxShadow: 'var(--shadow-md)',
            maxWidth: 220,
          }}
        >
          {content}
          <TooltipPrimitive.Arrow
            width={8}
            height={4}
            style={{ fill: 'var(--text-primary)' }}
          />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  </TooltipPrimitive.Provider>
);
