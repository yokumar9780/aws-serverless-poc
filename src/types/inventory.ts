export interface Inventory {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  updatedAt: string;
}

export interface UpdateInventoryInput {
  productName: string;
  quantity: number;
  price: number;
}
