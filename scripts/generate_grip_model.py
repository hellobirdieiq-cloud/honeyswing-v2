import os
import torch
import torch.nn as nn
import coremltools as ct

OUTPUT_PATH = "modules/vision-camera-pose/ios/GripClassifier.mlpackage"

class PlaceholderGripModel(nn.Module):
    def __init__(self):
        super().__init__()

    def forward(self, x):
        batch = x.shape[0]
        device = x.device

        lead_hand = torch.full((batch, 3), 1.0 / 3.0, device=device)
        grip_style = torch.full((batch, 3), 1.0 / 3.0, device=device)
        trail_coverage = torch.full((batch, 3), 1.0 / 3.0, device=device)

        return lead_hand, grip_style, trail_coverage

def main():
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)

    model = PlaceholderGripModel()
    model.eval()

    example_input = torch.rand(1, 3, 224, 224)
    traced = torch.jit.trace(model, example_input)

    mlmodel = ct.convert(
        traced,
        convert_to="mlprogram",
        inputs=[
            ct.ImageType(
                name="image",
                shape=example_input.shape,
                color_layout=ct.colorlayout.RGB,
            )
        ],
        outputs=[
            ct.TensorType(name="leadHand"),
            ct.TensorType(name="gripStyle"),
            ct.TensorType(name="trailCoverage"),
        ],
        minimum_deployment_target=ct.target.iOS16,
    )

    mlmodel.save(OUTPUT_PATH)
    print(f"Saved model to: {OUTPUT_PATH}")

if __name__ == "__main__":
    main()
