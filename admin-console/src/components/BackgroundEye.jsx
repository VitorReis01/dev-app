import React from "react";
import "./background-eye.css";

export default function BackgroundEye() {
  return (
    <div className="bg-eye" aria-hidden="true">
      <img className="bg-eye__img" src="/eye-cyber.png" alt="" />
      <div className="bg-eye__vignette" />
    </div>
  );
}
