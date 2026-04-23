import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';

interface DisconnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountName: string;
  isAgency: boolean;
  onConfirm: () => void;
}

export function DisconnectDialog({
  open,
  onOpenChange,
  accountName,
  isAgency,
  onConfirm,
}: DisconnectDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Отключить кабинет «{accountName}»?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Будут удалены все кампании, объявления и данные кабинета.{' '}
            {isAgency
              ? 'Для повторного подключения нужно будет запросить доступ у вашего агентского провайдера.'
              : 'Для повторного подключения потребуется обратиться в поддержку VK с гарантийным письмом от собственника рекламного кабинета.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="disconnect-confirm-no">
            Отмена
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="disconnect-confirm-yes"
          >
            Отключить
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
