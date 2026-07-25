import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { MeResponse } from '../lib/types';
import { AppShell } from './Shell';
import { PageState } from './Ui';

export function TeacherPage({ active, children }: { active: string; children: (session: MeResponse) => ReactNode }) {
  const session = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });

  if (session.isPending) return <PageState title="正在打开老师工作台…" />;
  if (session.isError || (session.data.role !== 'teacher' && session.data.role !== 'admin')) return <Navigate to="/login" replace />;

  return <AppShell role="teacher" active={active} campSlug={session.data.camp.slug} avatar={session.data.user.display_name}>{children(session.data)}</AppShell>;
}
