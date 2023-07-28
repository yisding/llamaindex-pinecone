import { NodeWithEmbedding, BaseNode } from "llamaindex";
import { PineconeClient, Vector } from "@pinecone-database/pinecone";
import { NaiveSparseValueBuilder, utils, PineconeVectorsBuilder } from ".";
import { VectorOperationsApi } from "@pinecone-database/pinecone/dist/pinecone-generated-ts-fetch";
import { } from "./vectors/PineconeVectorsBuilder";

type PineconeVectorStoreOptions = {
  indexName: string;
  client?: PineconeClient;
  namespace?: string;
  // class that implements SparseValueBuilder.
  // Can't to `typeof` with an interface :(
  sparseVectorBuilder?: { new(embeddings: number[]): SparseValueBuilder };
}

type PineconeIndex = VectorOperationsApi;

type PineconeNamespaceSummary = {
  vectorCount?: number;
}

type PineconeIndexStats = {
  // If there are namespaces for this index,
  // this will be a map of namespace name to a summary for
  // that namespace. At the moment, that only includes the count
  // of the vectors.
  namespaces?: Record<string, PineconeNamespaceSummary>;
  dimension: number;
  indexFullness: number;
  totalVectorCount: number;
}

type PineconeUpsertOptions = {
  batchSize?: number;
  includeSparseValues?: boolean;
}

export class PineconeVectorStore {
  indexName: string;
  namespace: string | undefined;
  client: PineconeClient | undefined;
  sparseVectorBuilder: { new(embeddings: number[]): SparseValueBuilder };

  pineconeIndex: PineconeIndex | undefined;
  pineconeIndexStats: PineconeIndexStats | undefined;

  constructor(options: PineconeVectorStoreOptions) {
    this.client = options.client;
    this.indexName = options.indexName;
    this.namespace = options.namespace;
    this.sparseVectorBuilder = options.sparseVectorBuilder || NaiveSparseValueBuilder;
  }

  /**
   * Returns or initializes a PineconeClient instance. This is necessary
   * because the Pinecone client requires an async init function, so it
   * cannot be initialized in the constructor.
   *
   * @returns {Promise<PineconeClient>} PineconeClient instance
   */
  async getPineconeClient(): Promise<PineconeClient> {
    if (this.client) {
      return Promise.resolve(this.client);
    }
    this.client = new PineconeClient();
    await this.client.init(utils.getPineconeConfigFromEnv());
    return this.client;
  }

  /**
   * Returns a pinecone index instance for the store's indexName.
   *  
   * An Index is actually an API clientish object (VectorOperationsApi)
   * that allows operations on indicies (e.g. upsert, querying, etc.)
   * backed by the API. This is aliased to the PineconeIndex type.
   * 
   * @returns {Promise<PineconeIndex>} Pinecone Index instance
   */
  async getIndex(): Promise<PineconeIndex> {
    if (this.pineconeIndex) {
      return Promise.resolve(this.pineconeIndex);
    }
    const client = await this.getPineconeClient();
    this.pineconeIndex = client.Index(this.indexName);
    return this.pineconeIndex;
  }

  async getIndexStats(): Promise<PineconeIndexStats> {
    if (this.pineconeIndexStats) {
      return Promise.resolve(this.pineconeIndexStats);
    }
    const index = await this.getIndex();
    const indexStats = await index.describeIndexStats({ describeIndexStatsRequest: {} });
    this.pineconeIndexStats = indexStats as PineconeIndexStats;
    return Promise.resolve(this.pineconeIndexStats);
  }

  /**
   * Upsert llamaindex Nodes into a Pinecone index.
   * Builds vectors from the embeddings of the nodes, including metadata,
   * then upserts them into the index.
   * Optionally includes sparse values and pads embeddings to the index's dimension.
   * 
   * @param {NodeWithEmbedding[]} nodesWithEmbeddings - an array of Nodes with embeddings.
   * @param {PineconeUpsertOptions} upsertOptions - options for the upsert operation, like whether to
   * include sparse values.
   * @returns the numer of vectors affected (created or updated).
  */
  async upsert(
    nodesWithEmbeddings: NodeWithEmbedding[],
    upsertOptions: PineconeUpsertOptions = {}
  ): Promise<number> {
    const builtVectors: Array<Vector> = [];

    // Loop over each of the nodes with embeddings, build vectors. We flatten
    // all vectors into a single list for upsertion.
    for (const nodeWithEmbedding of nodesWithEmbeddings) {
      const node = nodeWithEmbedding.node;
      const embedding = nodeWithEmbedding.embedding;
      if (!embedding) {
        throw new Error(`Node ${node.nodeId} does not have an embedding.`);
      }

      // Fetch stats about the index so we know its dimension.
      const indexStats = await this.getIndexStats();

      // Build the vectors for this node + embedding pair.
      const vectorsBuilder = new PineconeVectorsBuilder(
        node,
        embedding,
        { includeSparseValues: upsertOptions.includeSparseValues, dimension: indexStats.dimension }
      );
      const vectors = vectorsBuilder.buildVectors()
      builtVectors.push(...vectors);
    }

    const index = await this.getIndex();

    let upsertedCount = 0;
    try {
      const upsertResponse = await index.upsert({ upsertRequest: { vectors: builtVectors } });
      upsertedCount = upsertResponse.upsertedCount || 0;
    } catch (e) {
      throw e;
    }
    return upsertedCount;
  }

}