export interface LocalPersistenceStatus {
  status: "ok";
  databasePath: string;
  displayPath: string;
  checkedAt: string;
  checkKey: string;
  checkValue: string;
}
