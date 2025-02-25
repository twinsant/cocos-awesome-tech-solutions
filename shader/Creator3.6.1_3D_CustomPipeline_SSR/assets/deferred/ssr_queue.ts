import { CachedArray, CCString, ccenum, gfx, pipeline, PipelineStateManager, RecyclePool, _decorator, getPhaseID as cc_getPhaseID} from "cc";
const { ccclass, property } = _decorator;

export enum RenderQueueSortMode {
    FRONT_TO_BACK,
    BACK_TO_FRONT,
}
ccenum(RenderQueueSortMode);

@ccclass('RenderQueueDescEx')
export class RenderQueueDescEx {
    @property
    isTransparent: boolean = false;
    @property({ type: RenderQueueSortMode })
    sortMode: RenderQueueSortMode | number = RenderQueueSortMode.BACK_TO_FRONT;
    @property([CCString])
    stages: string[] = [];
}


/**
 * @en Comparison sorting function. Opaque objects are sorted by priority -> depth front to back -> shader ID.
 * @zh 比较排序函数。不透明对象按优先级 -> 深度由前向后 -> Shader ID 顺序排序。
 */
export function opaqueCompareFn(a: pipeline.IRenderPass, b: pipeline.IRenderPass) {
    return (a.hash - b.hash) || (a.depth - b.depth) || (a.shaderId - b.shaderId);
}

/**
 * @en Comparison sorting function. Transparent objects are sorted by priority -> depth back to front -> shader ID.
 * @zh 比较排序函数。半透明对象按优先级 -> 深度由后向前 -> Shader ID 顺序排序。
 */
export function transparentCompareFn(a: pipeline.IRenderPass, b: pipeline.IRenderPass) {
    return (a.priority - b.priority) || (a.hash - b.hash) || (b.depth - a.depth) || (a.shaderId - b.shaderId);
}

// export const getPhaseID = (() => {
//     const phases: Map<string, number> = new Map<string, number>();
//     let phaseNum = 0;
//     return (phaseName: string | number) => {
//         if (typeof phaseName === 'number') { return phaseName; }
//         if (!phases.has(phaseName)) {
//             phases.set(phaseName, 1 << phaseNum);
//             phaseNum++;
//         }
//         return phases.get(phaseName)!;
//     };
// })();

export const getPhaseID = cc_getPhaseID;

/**
 * @en The render queue. It manages a GFX [[RenderPass]] queue which will be executed by the [[RenderStage]].
 * @zh 渲染队列。它管理一个 GFX [[RenderPass]] 队列，队列中的渲染过程会被 [[RenderStage]] 所执行。
 */
export class RenderQueue {
    /**
     * @en A cached array of render passes
     * @zh 基于缓存数组的渲染过程队列。
     */
    public queue: CachedArray<pipeline.IRenderPass>;

    private _passDesc: pipeline.IRenderQueueDesc;
    private _passPool: RecyclePool<pipeline.IRenderPass>;

    /**
     * @en Construct a RenderQueue with render queue descriptor
     * @zh 利用渲染队列描述来构造一个 RenderQueue。
     * @param desc Render queue descriptor
     */
    constructor(desc: pipeline.IRenderQueueDesc) {
        this._passDesc = desc;
        this._passPool = new RecyclePool<pipeline.IRenderPass>(() => ({
            priority: 0,
            hash: 0,
            depth: 0,
            shaderId: 0,
            subModel: null!,
            passIdx: 0,
        }), 64);
        this.queue = new CachedArray(64, this._passDesc.sortFunc);
    }

    /**
     * @en Clear the render queue
     * @zh 清空渲染队列。
     */
    public clear() {
        this.queue.clear();
        this._passPool.reset();
    }

    /**
     * @en Insert a render pass into the queue
     * @zh 插入渲染过程。
     * @param renderObj The render object of the pass
     * @param modelIdx The model id
     * @param passIdx The pass id
     * @returns Whether the new render pass is successfully added
     */
    public insertRenderPass(renderObj: pipeline.IRenderObject, subModelIdx: number, passIdx: number): boolean {
        const subModel = renderObj.model.subModels[subModelIdx];
        const pass = subModel.passes[passIdx];
        const shader = subModel.shaders[passIdx];
        const isTransparent = pass.blendState.targets[0].blend;
        if (isTransparent !== this._passDesc.isTransparent || !(pass.phase & this._passDesc.phases)) {
            return false;
        }
        const hash = (0 << 30) | pass.priority << 16 | subModel.priority << 8 | passIdx;
        const rp = this._passPool.add();
        rp.priority = renderObj.model.priority;
        rp.hash = hash;
        rp.depth = renderObj.depth || 0;
        rp.shaderId = shader.typedID;
        rp.subModel = subModel;
        rp.passIdx = passIdx;
        this.queue.push(rp);
        return true;
    }

    /**
     * @en Sort the current queue
     * @zh 排序渲染队列。
     */
    public sort() {
        this.queue.sort();
    }

    public recordCommandBuffer(device: gfx.Device, renderPass: gfx.RenderPass, cmdBuff: gfx.CommandBuffer) {
        for (let i = 0; i < this.queue.length; ++i) {
            const { subModel, passIdx } = this.queue.array[i];
            const { inputAssembler } = subModel;
            const pass = subModel.passes[passIdx];
            const shader = subModel.shaders[passIdx];
            const pso = PipelineStateManager.getOrCreatePipelineState(device, pass, shader, renderPass, inputAssembler);
            cmdBuff.bindPipelineState(pso);
            cmdBuff.bindDescriptorSet(pipeline.SetIndex.MATERIAL, pass.descriptorSet);
            cmdBuff.bindDescriptorSet(pipeline.SetIndex.LOCAL, subModel.descriptorSet);
            cmdBuff.bindInputAssembler(inputAssembler);
            cmdBuff.draw(inputAssembler);
        }
    }
}

export function convertRenderQueue(desc: RenderQueueDescEx) {
    let phase = 0;
    for (let j = 0; j < desc.stages.length; j++) {
        phase |= getPhaseID(desc.stages[j]);
    }
    let sortFunc: (a: pipeline.IRenderPass, b: pipeline.IRenderPass) => number = opaqueCompareFn;
    switch (desc.sortMode) {
        case RenderQueueSortMode.BACK_TO_FRONT:
            sortFunc = transparentCompareFn;
            break;
        case RenderQueueSortMode.FRONT_TO_BACK:
            sortFunc = opaqueCompareFn;
            break;
        default:
            break;
    }

    return new RenderQueue({
        isTransparent: desc.isTransparent,
        phases: phase,
        sortFunc,
    });
}

/**
 * @en Clear the given render queue
 * @zh 清空指定的渲染队列
 * @param rq The render queue
 */
export function renderQueueClearFunc(rq: RenderQueue) {
    rq.clear();
}

/**
 * @en Sort the given render queue
 * @zh 对指定的渲染队列执行排序
 * @param rq The render queue
 */
export function renderQueueSortFunc(rq: RenderQueue) {
    rq.sort();
}
