import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Loader2, Blocks } from 'lucide-react';
import { Id } from '../../../convex/_generated/dataModel';

interface AdminModulesTabProps {
  sessionToken: string;
}

export function AdminModulesTab({ sessionToken }: AdminModulesTabProps) {
  const users = useQuery(api.admin.listUsersModules, { sessionToken });
  const toggleRotation = useMutation(api.admin.toggleVideoRotation);

  if (users === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Blocks className="h-5 w-5 text-primary" />
          Модули пользователей
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 font-medium text-muted-foreground">Пользователь</th>
                <th className="text-left py-2 px-3 font-medium text-muted-foreground">Email</th>
                <th className="text-center py-2 px-3 font-medium text-muted-foreground">Ротация кампаний</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u._id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="py-2 px-3">{u.name}</td>
                  <td className="py-2 px-3 text-muted-foreground">{u.email}</td>
                  <td className="py-2 px-3 text-center">
                    <button
                      onClick={() =>
                        toggleRotation({
                          sessionToken,
                          targetUserId: u._id as Id<"users">,
                          enabled: !u.videoRotationEnabled,
                        })
                      }
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        u.videoRotationEnabled ? 'bg-primary' : 'bg-muted'
                      }`}
                      data-testid={`toggle-rotation-${u._id}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          u.videoRotationEnabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
