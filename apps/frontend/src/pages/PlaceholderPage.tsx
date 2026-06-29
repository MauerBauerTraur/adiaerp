import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface PlaceholderPageProps {
  title: string;
  description?: string;
}

/**
 * Generic placeholder for module screens not yet built.
 * Real screens (stock, replenishment, dashboard, ...) arrive in Sprint 1+.
 */
export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Tez orada</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Bu modul Faza-1 keyingi sprintlarida ishlab chiqiladi. Hozircha
            faqat interfeys skeleti tayyorlandi.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
