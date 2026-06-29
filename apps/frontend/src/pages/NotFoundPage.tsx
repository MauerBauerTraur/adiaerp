import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
      <p className="text-5xl font-semibold text-primary">404</p>
      <h1 className="text-xl font-medium">Sahifa topilmadi</h1>
      <p className="text-sm text-muted-foreground">
        So‘ralgan sahifa mavjud emas yoki ko‘chirilgan.
      </p>
      <Button asChild>
        <Link to="/dashboard">Boshqaruv paneliga qaytish</Link>
      </Button>
    </div>
  );
}
