import { Link } from 'react-router-dom';

export function SubmissionCta({ label = '提交作品', className = 'button button-coral' }: { label?: string; className?: string }) {
  return <Link className={className} to="/app/submit">{label}</Link>;
}
