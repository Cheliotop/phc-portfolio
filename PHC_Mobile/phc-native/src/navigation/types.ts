import type { StackNavigationProp } from '@react-navigation/stack';
import type { MaterialTopTabNavigationProp } from '@react-navigation/material-top-tabs';

export type RootStackParamList = {
  Login: undefined;
  OperatorDashboard: undefined;
  AdminDashboard: undefined;
};

export type RootStackNavigationProp<RouteName extends keyof RootStackParamList> =
  StackNavigationProp<RootStackParamList, RouteName, 'RootStack'>;

export type OperatorTabParamList = {
  Turnos: undefined;
  Pozos: undefined;
  Progreso: undefined;
  Materiales: undefined;
  Pedidos: undefined;
  Muestras: undefined;
  Cierre: undefined;
};

export type OperatorTabNavigationProp<RouteName extends keyof OperatorTabParamList> =
  MaterialTopTabNavigationProp<OperatorTabParamList, RouteName, 'OperatorTabs'>;

export type AdminTabParamList = {
  Overview: undefined;
  Projects: undefined;
  Catalog: undefined;
  Operation: undefined;
  Operators: undefined;
  Requests: undefined;
  CompletionReports: undefined;
  RejectedWork: undefined;
};

export type AdminTabNavigationProp<RouteName extends keyof AdminTabParamList> =
  MaterialTopTabNavigationProp<AdminTabParamList, RouteName, 'AdminTabs'>;

declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
