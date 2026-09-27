export function PageIntro({ label, title, description }: { label: string; title: string; description: string }) {
  return (
    <div className="page-intro">
      <span className="eyebrow">{label}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
