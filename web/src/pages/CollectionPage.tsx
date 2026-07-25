import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { ModeTabs } from '../components/Shell';
import { Avatar, PageState, WorkThumbnail } from '../components/Ui';
import { formatDate, formatNumber } from '../lib/presentation';
import type { CampCollection } from '../lib/types';

export function CollectionPage() {
  const { campSlug = '' } = useParams();
  const collection = useQuery({ queryKey: ['collection', campSlug], queryFn: () => api.collection(campSlug), retry: false });
  if (collection.isPending) return <PageState title="正在打开作品集合…" />;
  if (collection.isError) return <PageState error={collection.error} />;
  return <Collection collection={collection.data} />;
}

function Collection({ collection }: { collection: CampCollection }) {
  const [category, setCategory] = useState('全部作品');
  const items = category === '全部作品' ? collection.items : collection.items.filter((item) => item.category === category);
  return <main className="collection-page"><header className="collection-nav"><Link to={`/c/${collection.camp.slug}`} className="collection-brand"><span className="brand-mark">V</span><b>{collection.camp.name}</b></Link><nav className="collection-links"><a href="#works" className="is-active">作品集合</a><a href="#course">关于课程</a></nav><ModeTabs campSlug={collection.camp.slug} active="collection" /></header><section className="collection-hero" id="course"><p className="eyebrow">{collection.camp.theme || 'VIBE CODING'}</p><div className="hero-grid"><div><h1>把每个人的想法，<br />vibe 在一起</h1><p>{collection.camp.intro || '这里收集了课程中已经正式发布的作品。每一个入口，都通往一位学员亲手完成的产品。'}</p></div><dl className="collection-stats"><Stat value={collection.stats.published} label="个作品已上线" /><Stat value={collection.stats.creators} label="位共同创作者" /><Stat value={collection.stats.categories} label="个创作主题" /></dl></div></section><section className="works-section" id="works"><header><p className="eyebrow">浏览作品</p><div><h2>从一个好奇心开始</h2><span>{items.length} 个作品</span></div><div className="category-chips">{['全部作品', ...collection.categories].map((chip) => <button className={chip === category ? 'is-active' : ''} key={chip} onClick={() => setCategory(chip)}>{chip}</button>)}</div></header>{items.length ? <div className="works-grid">{items.map((item) => <article className={`work-card${item.featured ? ' is-featured' : ''}`} key={item.slug}><WorkThumbnail coverUrl={item.cover_url} url={item.url} title={item.title} /><div className="work-copy"><small>{item.category || '作品'}</small><h3>{item.title}</h3><p>{item.tagline || '作者暂未填写作品简介。'}</p></div><footer><span className="work-author"><Avatar name={item.author} url={item.avatar_url} />{item.author}<em>{item.version || '版本未标注'}</em></span><span className="work-meta">◉ {formatNumber(item.views)}　<a href={item.url || undefined} target="_blank" rel="noreferrer">{item.featured ? '进入作品' : '查看作品'}　→</a></span></footer></article>)}</div> : <div className="collection-empty"><strong>这个分类还没有正式上线的作品</strong><p>换一个分类看看，或等待学员的作品通过审核。</p></div>}</section><footer className="collection-footer"><b>▦　{collection.camp.name}</b><span>♧ 由 {formatNumber(collection.stats.creators)} 位学员共同创作</span><span>最后更新于 {formatDate(collection.updated_at)}</span></footer></main>;
}

function Stat({ value, label }: { value?: number; label: string }) { return <div><dt>{formatNumber(value)}</dt><dd>{label}</dd></div>; }
