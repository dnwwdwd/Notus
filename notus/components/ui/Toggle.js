// Toggle switch
export const Toggle = ({ on, onChange }) => (
  <button
    onClick={() => onChange?.(!on)}
    style={{
      width: 40,
      height: 22,
      borderRadius: 'var(--radius-full)',
      background: on ? 'var(--accent)' : 'var(--bg-active)',
      position: 'relative',
      transition: 'background var(--transition-normal)',
      cursor: 'pointer',
    }}
  >
    <div
      style={{
        position: 'absolute',
        top: 2,
        left: on ? 20 : 2,
        width: 18,
        height: 18,
        background: '#fff',
        borderRadius: '50%',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        transition: 'left var(--transition-normal)',
      }}
    />
  </button>
);
